use super::{diff, Ask};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::{Duration, Instant};

/// Default model; override with `ASSISTANT_MODEL`.
const DEFAULT_MODEL: &str = "gpt-6.1-sol";
/// Upper bound on changed (`+`/`-`) lines in one proposal.
const MAX_CHANGED_LINES: usize = 200;
/// The selection is only context, so a longer one is trimmed, not refused.
const MAX_SELECTION_BYTES: usize = 4000;
/// Longest reply message kept; a longer one is trimmed.
const MAX_MESSAGE_BYTES: usize = 8000;
/// Per upstream call. Full-code replies take longer than patches did.
const CALL_TIMEOUT: Duration = Duration::from_secs(120);
/// A second call is made only if the first finished within this.
const RETRY_WITHIN: Duration = Duration::from_secs(60);

/// One message of conversation history, as sent to the model.
#[derive(Clone, Debug, Serialize)]
pub(super) struct Message {
    pub role: &'static str,
    pub content: String,
}

/// One upstream call, for the interaction log.
#[derive(Debug, Serialize)]
pub(super) struct Attempt {
    /// The model's raw output text.
    pub output: String,
    /// Why this attempt wasn't used as the reply, if it wasn't.
    pub problem: Option<String>,
    pub took_ms: u64,
    pub usage: Value,
}

/// The reply shown in the chat.
#[derive(Debug, PartialEq, Eq)]
pub(super) struct Reply {
    /// `edit`, `clarify` or `answer`.
    pub kind: String,
    pub message: String,
    pub patch: Option<String>,
    /// A note from the server, such as why an edit isn't shown.
    pub notice: Option<String>,
}

/// What the model returns, per the response schema in [`payload`].
#[derive(Deserialize)]
struct ModelReply {
    kind: String,
    message: String,
    code: Option<String>,
}

enum Transport {
    OpenAi {
        key: Option<String>,
        http: reqwest::Client,
    },
    #[cfg(test)]
    Scripted {
        replies: parking_lot::Mutex<std::collections::VecDeque<Result<Value, String>>>,
        sent: parking_lot::Mutex<Vec<Value>>,
    },
}

pub(super) struct AssistantClient {
    transport: Transport,
    model: String,
}

impl AssistantClient {
    pub fn new(key: Option<String>) -> Self {
        Self {
            transport: Transport::OpenAi {
                key: key.filter(|k| !k.is_empty()),
                http: reqwest::Client::builder()
                    .https_only(true)
                    .timeout(CALL_TIMEOUT)
                    .build()
                    .expect("HTTP client"),
            },
            model: std::env::var("ASSISTANT_MODEL")
                .ok()
                .filter(|m| !m.is_empty())
                .unwrap_or_else(|| DEFAULT_MODEL.into()),
        }
    }

    /// A client that answers with `replies` in order instead of calling OpenAI.
    #[cfg(test)]
    pub fn scripted(replies: Vec<Result<Value, String>>) -> Self {
        Self {
            transport: Transport::Scripted {
                replies: parking_lot::Mutex::new(replies.into()),
                sent: Default::default(),
            },
            model: DEFAULT_MODEL.into(),
        }
    }

    /// Request bodies a scripted client received.
    #[cfg(test)]
    pub fn sent(&self) -> Vec<Value> {
        match &self.transport {
            Transport::Scripted { sent, .. } => sent.lock().clone(),
            Transport::OpenAi { .. } => Vec::new(),
        }
    }

    pub fn model(&self) -> &str {
        &self.model
    }

    /// Answer `ask`, recording every upstream call in `attempts`.
    ///
    /// `asked_already` means the previous reply was a clarifying question, so
    /// this one must not be another.
    pub async fn reply(
        &self,
        history: Vec<Message>,
        ask: &Ask,
        asked_already: bool,
        attempts: &mut Vec<Attempt>,
    ) -> Result<Reply, String> {
        let instructions = match std::env::var("ASSISTANT_PROMPT_PATH") {
            Ok(path) => tokio::fs::read_to_string(&path)
                .await
                .map_err(|e| format!("Can't read the assistant prompt file {path}: {e}"))?,
            Err(_) => include_str!("../../prompts/assistant.md").to_owned(),
        };
        if instructions.len() > 16_000 {
            return Err("The assistant prompt is over 16,000 bytes".into());
        }
        let started = Instant::now();
        let mut input = conversation(history, ask, asked_already);
        for attempt in 0..2 {
            let call = Instant::now();
            let sent = self
                .send(&payload(&self.model, input.clone(), &instructions))
                .await;
            let took_ms = call.elapsed().as_millis() as u64;
            // Measured after the call, so a slow first reply gets no second one.
            let can_retry = attempt == 0 && started.elapsed() < RETRY_WITHIN;
            let data = match sent {
                Ok(data) => data,
                Err(problem) => {
                    attempts.push(Attempt {
                        output: String::new(),
                        problem: Some(problem.clone()),
                        took_ms,
                        usage: Value::Null,
                    });
                    return Err(problem);
                }
            };
            let output = raw_output(&data);
            let mut record = |problem: Option<String>| {
                attempts.push(Attempt {
                    output: output.clone(),
                    problem,
                    took_ms,
                    usage: data["usage"].clone(),
                })
            };
            let model = match decode(&data) {
                Ok(model) => model,
                Err(problem) => {
                    record(Some(problem.clone()));
                    return Err(problem);
                }
            };
            if model.kind == "clarify" && asked_already && can_retry {
                record(Some("asked a second clarifying question".into()));
                input.push(json!({"role": "assistant", "content": output}));
                input.push(json!({"role": "user", "content":
                    "You already asked your one clarifying question and the user has answered. \
                     Do not ask another. Implement the request now from what the user has said, \
                     choosing the most likely correct reading of anything still unspecified, and \
                     state those assumptions briefly in message."}));
                continue;
            }
            let proposal = match model
                .code
                .as_deref()
                .map(|code| diff::propose(&ask.code, code))
            {
                Some(Err(problem)) => {
                    record(Some(problem.clone()));
                    return Ok(Reply {
                        kind: "answer".into(),
                        message: model.message,
                        patch: None,
                        notice: Some(format!(
                            "The suggested edit couldn't be shown ({problem}). Your code is \
                             unchanged; ask again."
                        )),
                    });
                }
                Some(Ok(proposal)) => proposal,
                None => None,
            };
            if let Some(proposal) = proposal.as_ref().filter(|p| p.changed > MAX_CHANGED_LINES) {
                let problem = format!(
                    "the edit changes {} lines, over the {MAX_CHANGED_LINES}-line limit",
                    proposal.changed
                );
                record(Some(problem.clone()));
                if can_retry {
                    input.push(json!({"role": "assistant", "content": output}));
                    input.push(json!({"role": "user", "content": format!(
                        "Your edit changes {} lines, over the {MAX_CHANGED_LINES}-line limit. \
                         Return the code again, changing only what this request needs.",
                        proposal.changed
                    )}));
                    continue;
                }
                return Ok(Reply {
                    kind: "answer".into(),
                    message: model.message,
                    patch: None,
                    notice: Some(format!(
                        "The suggested edit isn't shown because it changes {} lines, over the \
                         {MAX_CHANGED_LINES}-line limit. Ask for a smaller step.",
                        proposal.changed
                    )),
                });
            }
            record(None);
            let mut reply = Reply {
                kind: model.kind,
                message: model.message,
                patch: proposal.map(|p| p.patch),
                notice: None,
            };
            match (&reply.patch, reply.kind.as_str()) {
                (Some(_), _) => reply.kind = "edit".into(),
                (None, "edit") => {
                    reply.kind = "answer".into();
                    reply.notice = Some("No code changed.".into());
                }
                _ => {}
            }
            return Ok(reply);
        }
        unreachable!("the second attempt always returns")
    }

    async fn send(&self, body: &Value) -> Result<Value, String> {
        match &self.transport {
            Transport::OpenAi { key, http } => {
                let key = key
                    .as_deref()
                    .ok_or("OPENAI_API_KEY is not configured on the server")?;
                let response = http
                    .post("https://api.openai.com/v1/responses")
                    .bearer_auth(key)
                    .json(body)
                    .send()
                    .await
                    .map_err(|e| {
                        if e.is_timeout() {
                            format!(
                                "OpenAI didn't answer within {} seconds",
                                CALL_TIMEOUT.as_secs()
                            )
                        } else {
                            format!("Couldn't reach OpenAI: {e}")
                        }
                    })?;
                let status = response.status();
                let data: Value = response.json().await.unwrap_or(Value::Null);
                if !status.is_success() {
                    let detail = data["error"]["message"].as_str().unwrap_or("no details");
                    return Err(format!(
                        "OpenAI returned HTTP {}: {}",
                        status.as_u16(),
                        truncate(detail, 500)
                    ));
                }
                Ok(data)
            }
            #[cfg(test)]
            Transport::Scripted { replies, sent } => {
                sent.lock().push(body.clone());
                replies
                    .lock()
                    .pop_front()
                    .unwrap_or_else(|| Err("no scripted reply left".into()))
            }
        }
    }
}

/// `text` cut to at most `max` bytes, on a character boundary.
fn truncate(text: &str, max: usize) -> &str {
    let mut end = text.len().min(max);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

fn conversation(history: Vec<Message>, ask: &Ask, asked_already: bool) -> Vec<Value> {
    let mut input = serde_json::to_value(history)
        .unwrap()
        .as_array()
        .unwrap()
        .clone();
    let mut turn = json!({
        "question": ask.message,
        "current_code": ask.code,
        "language": ask.language,
    });
    if let Some(cursor) = &ask.cursor {
        turn["cursor"] = json!({
            "line": cursor.line,
            "line_text": ask.code.split('\n').nth(cursor.line.saturating_sub(1) as usize),
            "selection": truncate(&cursor.selection, MAX_SELECTION_BYTES),
        });
    }
    if asked_already {
        turn["note"] = json!(
            "Your previous reply was a clarifying question, so this message is the answer. \
             Do not ask another question: implement the request now."
        );
    }
    input.push(json!({"role": "user", "content": turn.to_string()}));
    input
}

fn payload(model: &str, input: Vec<Value>, instructions: &str) -> Value {
    json!({
        "model": model, "store": false, "instructions": instructions,
        "input": input, "reasoning": {"effort": "low"}, "max_output_tokens": 32000,
        "text": {"format": {"type": "json_schema", "name": "pad_reply", "strict": true,
            "schema": {"type": "object", "additionalProperties": false,
                "properties": {
                    "kind": {"type": "string", "enum": ["edit", "clarify", "answer"]},
                    "message": {"type": "string"},
                    "code": {"anyOf": [{"type": "null"}, {"type": "string"}]}
                },
                "required": ["kind", "message", "code"]}}}
    })
}

fn output_parts<'a>(data: &'a Value, kind: &'a str) -> impl Iterator<Item = &'a str> {
    data["output"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|item| item["content"].as_array().into_iter().flatten())
        .filter(move |part| part["type"] == kind)
        .filter_map(move |part| part[if kind == "refusal" { "refusal" } else { "text" }].as_str())
}

fn raw_output(data: &Value) -> String {
    output_parts(data, "output_text").collect()
}

fn decode(data: &Value) -> Result<ModelReply, String> {
    let refusal: String = output_parts(data, "refusal").collect();
    if !refusal.is_empty() {
        return Err(format!("The model declined to answer: {refusal}"));
    }
    if data["status"] != "completed" {
        let reason = data["incomplete_details"]["reason"]
            .as_str()
            .or_else(|| data["status"].as_str())
            .unwrap_or("unknown");
        return Err(format!(
            "The model stopped before finishing ({reason}). Try a smaller request."
        ));
    }
    let mut reply: ModelReply = serde_json::from_str(&raw_output(data))
        .map_err(|e| format!("The model's reply wasn't in the expected format: {e}"))?;
    if !matches!(reply.kind.as_str(), "edit" | "clarify" | "answer") {
        return Err(format!(
            "The model replied with an unknown kind {:?}",
            reply.kind
        ));
    }
    reply.message = truncate(&reply.message, MAX_MESSAGE_BYTES).to_owned();
    Ok(reply)
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;

    pub fn ask(code: &str, message: &str) -> Ask {
        Ask {
            message: message.into(),
            code: code.into(),
            language: "python".into(),
            cursor: None,
        }
    }

    /// An OpenAI Responses API result carrying `reply` as its output text.
    pub fn completed(reply: Value) -> Value {
        json!({"status":"completed", "output":[{"content":[{
            "type":"output_text", "text": reply.to_string()
        }]}], "usage":{"input_tokens":10,"output_tokens":5}})
    }

    async fn run(
        replies: Vec<Result<Value, String>>,
        ask: &Ask,
        asked_already: bool,
    ) -> (Result<Reply, String>, Vec<Attempt>, Vec<Value>) {
        let client = AssistantClient::scripted(replies);
        let mut attempts = Vec::new();
        let reply = client
            .reply(vec![], ask, asked_already, &mut attempts)
            .await;
        (reply, attempts, client.sent())
    }

    #[test]
    fn request_has_no_tools_or_provider_conversation_storage() {
        let body = payload(
            DEFAULT_MODEL,
            conversation(vec![], &ask("x", "q"), false),
            "rules",
        );
        assert_eq!(body["model"], "gpt-6.1-sol");
        assert_eq!(body["store"], false);
        assert!(body.get("tools").is_none());
        assert_eq!(body["instructions"], "rules");
    }

    #[test]
    fn cursor_context_includes_the_line_text() {
        let mut req = ask("a = 1\nb = 2", "q");
        req.cursor = Some(super::super::Cursor {
            line: 2,
            selection: String::new(),
        });
        let input = conversation(vec![], &req, false);
        let turn: Value = serde_json::from_str(input[0]["content"].as_str().unwrap()).unwrap();
        assert_eq!(turn["cursor"]["line_text"], "b = 2");
        assert!(turn.get("note").is_none());
    }

    #[test]
    fn long_selections_are_trimmed_on_a_character_boundary() {
        let mut req = ask("a", "q");
        req.cursor = Some(super::super::Cursor {
            line: 1,
            selection: "é".repeat(MAX_SELECTION_BYTES),
        });
        let input = conversation(vec![], &req, false);
        let turn: Value = serde_json::from_str(input[0]["content"].as_str().unwrap()).unwrap();
        let sent = turn["cursor"]["selection"].as_str().unwrap();
        assert_eq!(sent.len(), MAX_SELECTION_BYTES);
        assert!(sent.chars().all(|c| c == 'é'));
    }

    #[tokio::test]
    async fn full_code_becomes_a_patch_that_applies() {
        let code = "def f():\n    return 1\n";
        let (reply, attempts, _) = run(
            vec![Ok(completed(
                json!({"kind":"edit","message":"Returns 2.","code":"def f():\n    return 2\n"}),
            ))],
            &ask(code, "return 2"),
            false,
        )
        .await;
        let reply = reply.unwrap();
        assert_eq!(reply.kind, "edit");
        assert_eq!(reply.message, "Returns 2.");
        let patch = reply.patch.unwrap();
        assert!(patch.contains("-    return 1\n+    return 2"), "{patch}");
        assert_eq!(attempts.len(), 1);
        assert!(attempts[0].problem.is_none());
        assert_eq!(attempts[0].usage["output_tokens"], 5);
    }

    #[tokio::test]
    async fn unchanged_code_is_an_answer() {
        let (reply, _, _) = run(
            vec![Ok(completed(
                json!({"kind":"edit","message":"Done.","code":"x = 1"}),
            ))],
            &ask("x = 1", "q"),
            false,
        )
        .await;
        let reply = reply.unwrap();
        assert_eq!(reply.kind, "answer");
        assert_eq!(reply.patch, None);
        assert_eq!(reply.notice.as_deref(), Some("No code changed."));
    }

    #[tokio::test]
    async fn a_second_clarifying_question_is_retried_as_an_edit() {
        let (reply, attempts, sent) = run(
            vec![
                Ok(completed(
                    json!({"kind":"clarify","message":"Which way?","code":null}),
                )),
                Ok(completed(
                    json!({"kind":"edit","message":"Assumed left.","code":"x = 2"}),
                )),
            ],
            &ask("x = 1", "just do it"),
            true,
        )
        .await;
        assert_eq!(reply.unwrap().kind, "edit");
        assert_eq!(attempts.len(), 2);
        assert_eq!(
            attempts[0].problem.as_deref(),
            Some("asked a second clarifying question")
        );
        let first: Value =
            serde_json::from_str(sent[0]["input"][0]["content"].as_str().unwrap()).unwrap();
        assert!(first["note"]
            .as_str()
            .unwrap()
            .contains("Do not ask another"));
        assert_eq!(sent[1]["input"].as_array().unwrap().len(), 3);
    }

    #[tokio::test]
    async fn a_first_clarifying_question_is_shown() {
        let (reply, attempts, _) = run(
            vec![Ok(completed(
                json!({"kind":"clarify","message":"Which way?","code":null}),
            ))],
            &ask("x = 1", "q"),
            false,
        )
        .await;
        assert_eq!(reply.unwrap().kind, "clarify");
        assert_eq!(attempts.len(), 1);
    }

    #[tokio::test]
    async fn oversized_edits_are_retried_then_explained() {
        let code = "x\n".repeat(10);
        let huge = "y\n".repeat(MAX_CHANGED_LINES + 10);
        let big = || {
            Ok(completed(
                json!({"kind":"edit","message":"Rewrote it.","code": huge}),
            ))
        };
        let (reply, attempts, _) = run(vec![big(), big()], &ask(&code, "q"), false).await;
        let reply = reply.unwrap();
        assert_eq!(reply.patch, None);
        assert_eq!(reply.message, "Rewrote it.");
        assert!(reply.notice.unwrap().contains("over the 200-line limit"));
        assert_eq!(attempts.len(), 2);
    }

    #[tokio::test]
    async fn upstream_failures_carry_the_reason() {
        let (reply, attempts, _) = run(
            vec![Err("OpenAI returned HTTP 429: slow down".into())],
            &ask("", "q"),
            false,
        )
        .await;
        assert_eq!(reply.unwrap_err(), "OpenAI returned HTTP 429: slow down");
        assert_eq!(
            attempts[0].problem.as_deref(),
            Some("OpenAI returned HTTP 429: slow down")
        );

        let incomplete =
            json!({"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"}});
        let (reply, _, _) = run(vec![Ok(incomplete)], &ask("", "q"), false).await;
        assert!(reply.unwrap_err().contains("max_output_tokens"));

        let refusal = json!({"status":"completed","output":[{"content":[{"type":"refusal","refusal":"No."}]}]});
        let (reply, _, _) = run(vec![Ok(refusal)], &ask("", "q"), false).await;
        assert_eq!(reply.unwrap_err(), "The model declined to answer: No.");
    }
}
