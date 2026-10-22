use super::{memory::Message, patch, ChatRequest};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;

/// Default model; override with `LUNA_MODEL`.
const DEFAULT_MODEL: &str = "gpt-6.1-sol";
/// Upper bound on changed (`+`/`-`) lines in one proposal.
const MAX_CHANGED_LINES: usize = 200;
/// Upper bound on a proposal's size.
const MAX_PATCH_BYTES: usize = 16_000;
/// The selection is only context, so a longer one is trimmed, not refused.
const MAX_SELECTION_BYTES: usize = 4000;
/// Per upstream call.
const CALL_TIMEOUT: Duration = Duration::from_secs(60);
/// A failed patch is retried only if the first call finished within this, so
/// one request stays under 90s, inside the browser's 120s limit.
const RETRY_WITHIN: Duration = Duration::from_secs(30);

#[derive(Deserialize, Serialize)]
pub(super) struct Answer {
    pub message: String,
    /// A context-anchored patch against `current_code`; see [`patch`].
    pub patch: Option<String>,
    #[serde(default)]
    pub cached_tokens: u64,
}

pub(super) struct LunaClient {
    key: Option<String>,
    model: String,
    http: reqwest::Client,
}

impl LunaClient {
    pub fn new(key: Option<String>) -> Self {
        Self {
            key,
            model: std::env::var("LUNA_MODEL")
                .ok()
                .filter(|m| !m.is_empty())
                .unwrap_or_else(|| DEFAULT_MODEL.into()),
            http: reqwest::Client::builder()
                .https_only(true)
                .timeout(CALL_TIMEOUT)
                .build()
                .expect("HTTP client"),
        }
    }

    pub async fn reply(
        &self,
        history: Vec<Message>,
        request: &ChatRequest,
    ) -> Result<Answer, String> {
        let key = self
            .key
            .as_ref()
            .filter(|k| !k.is_empty())
            .ok_or("Configure OPENAI_API_KEY in the server environment")?;
        let instructions = match std::env::var("LUNA_PROMPT_PATH") {
            Ok(path) => tokio::fs::read_to_string(path)
                .await
                .map_err(|_| "Cannot read Luna prompt file")?,
            Err(_) => include_str!("../../prompts/luna.md").to_owned(),
        };
        if instructions.len() > 16_000 {
            return Err("Luna prompt exceeds 16,000 bytes".into());
        }
        let started = std::time::Instant::now();
        let mut input = conversation(history, request);
        // Like Codex's apply_patch, a patch that doesn't apply goes back to the
        // model with the reason, once.
        for attempt in 0..2 {
            let body = payload(&self.model, input.clone(), &instructions);
            let data = self.send(key, &body).await?;
            let mut answer = decode(&data)?;
            let Some(proposal) = &answer.patch else {
                return Ok(answer);
            };
            match check(&request.code, proposal) {
                Ok(()) => return Ok(answer),
                Err(problem) if attempt == 0 && started.elapsed() < RETRY_WITHIN => {
                    input.push(json!({"role": "assistant", "content": raw_output(&data)}));
                    input.push(repair_request(request, &problem));
                }
                Err(problem) => {
                    answer.patch = None;
                    answer.message = rejected_patch_message(&problem);
                    return Ok(answer);
                }
            }
        }
        unreachable!("the loop returns on its last attempt")
    }

    async fn send(&self, key: &str, body: &Value) -> Result<Value, String> {
        let response = self
            .http
            .post("https://api.openai.com/v1/responses")
            .bearer_auth(key)
            .json(body)
            .send()
            .await
            .map_err(|_| "OpenAI request failed or timed out")?;
        if !response.status().is_success() {
            return Err(format!(
                "OpenAI returned HTTP {}. Check model access and account limits.",
                response.status().as_u16()
            ));
        }
        response
            .json()
            .await
            .map_err(|_| "Invalid OpenAI response".into())
    }
}

fn repair_request(request: &ChatRequest, problem: &str) -> Value {
    json!({"role": "user", "content": json!({
        "patch_error": problem,
        "current_code": request.code,
        "question": request.message,
        "language": request.language,
        "instruction": "Repair only the patch format or anchors for the original request. Copy anchors from current_code, not earlier proposals. Do not add new solution logic. Return a corrected patch, or patch null with an explanation if none is appropriate.",
    }).to_string()})
}

fn rejected_patch_message(problem: &str) -> String {
    format!("No edit was applied because the proposed patch failed validation: {problem}. Your code is unchanged.")
}

/// Validate a proposal against the code the model saw.
fn check(code: &str, proposal: &str) -> Result<(), String> {
    if proposal.len() > MAX_PATCH_BYTES || patch::changed_lines(proposal) > MAX_CHANGED_LINES {
        return Err(format!(
            "it changes more than {MAX_CHANGED_LINES} lines or {MAX_PATCH_BYTES} bytes; \
             propose a smaller step"
        ));
    }
    patch::locate(code, proposal).map(|_| ())
}

/// `text` cut to at most `max` bytes, on a character boundary.
fn truncate(text: &str, max: usize) -> &str {
    let mut end = text.len().min(max);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

fn conversation(history: Vec<Message>, request: &ChatRequest) -> Vec<Value> {
    let mut input = serde_json::to_value(history)
        .unwrap()
        .as_array()
        .unwrap()
        .clone();
    let mut turn = json!({
        "question": request.message,
        "current_code": request.code,
        "language": request.language,
    });
    if let Some(cursor) = &request.cursor {
        turn["cursor"] = json!({
            "line": cursor.line,
            "line_text": request.code.split('\n').nth(cursor.line.saturating_sub(1) as usize),
            "selection": truncate(&cursor.selection, MAX_SELECTION_BYTES),
        });
    }
    input.push(json!({"role": "user", "content": turn.to_string()}));
    input
}

fn payload(model: &str, input: Vec<Value>, instructions: &str) -> Value {
    json!({
        "model": model, "store": false, "instructions": instructions,
        "input": input, "reasoning": {"effort": "low"}, "max_output_tokens": 12000,
        "text": {"format": {"type": "json_schema", "name": "pad_reply", "strict": true,
            "schema": {"type": "object", "additionalProperties": false,
                "properties": {
                    "message": {"type": "string"},
                    "patch": {"anyOf": [{"type": "null"}, {"type": "string"}]}
                },
                "required": ["message", "patch"]}}}
    })
}

fn raw_output(data: &Value) -> String {
    data["output"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|item| item["content"].as_array().into_iter().flatten())
        .filter(|part| part["type"] == "output_text")
        .filter_map(|part| part["text"].as_str())
        .collect()
}

fn decode(data: &Value) -> Result<Answer, String> {
    if data["status"] != "completed" {
        return Err("Luna did not finish; try a smaller request".into());
    }
    let mut answer: Answer =
        serde_json::from_str(&raw_output(data)).map_err(|_| "Luna returned an invalid reply")?;
    if answer.message.len() > 8000 {
        return Err("Luna reply was too long".into());
    }
    if answer.patch.as_deref().is_some_and(|p| p.trim().is_empty()) {
        answer.patch = None;
    }
    answer.cached_tokens = data["usage"]["input_tokens_details"]["cached_tokens"]
        .as_u64()
        .unwrap_or(0);
    Ok(answer)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(code: &str) -> ChatRequest {
        ChatRequest {
            pad_id: "p".into(),
            message: "help".into(),
            code: code.into(),
            language: "python".into(),
            cursor: None,
        }
    }

    fn completed(reply: Value) -> Value {
        json!({"status":"completed", "output":[{"content":[{
            "type":"output_text", "text": reply.to_string()
        }]}], "usage":{"input_tokens_details":{"cached_tokens":128}}})
    }

    #[test]
    fn request_has_no_tools_or_provider_conversation_storage() {
        let body = payload(
            DEFAULT_MODEL,
            conversation(vec![], &request("x")),
            "test instructions",
        );
        assert_eq!(body["model"], "gpt-6.1-sol");
        assert_eq!(body["store"], false);
        assert!(body.get("tools").is_none());
        assert_eq!(body["instructions"], "test instructions");
    }

    #[test]
    fn cursor_context_includes_the_line_text() {
        let mut req = request("a = 1\nb = 2");
        req.cursor = Some(super::super::Cursor {
            line: 2,
            selection: String::new(),
        });
        let input = conversation(vec![], &req);
        let turn: Value = serde_json::from_str(input[0]["content"].as_str().unwrap()).unwrap();
        assert_eq!(turn["cursor"]["line_text"], "b = 2");
    }

    #[test]
    fn long_selections_are_trimmed_on_a_character_boundary() {
        let mut req = request("a");
        req.cursor = Some(super::super::Cursor {
            line: 1,
            selection: "é".repeat(MAX_SELECTION_BYTES),
        });
        let input = conversation(vec![], &req);
        let turn: Value = serde_json::from_str(input[0]["content"].as_str().unwrap()).unwrap();
        let sent = turn["cursor"]["selection"].as_str().unwrap();
        assert_eq!(sent.len(), MAX_SELECTION_BYTES);
        assert!(sent.chars().all(|c| c == 'é'));
    }

    #[test]
    fn refuses_incomplete_and_reads_patches() {
        assert!(decode(&json!({"status":"incomplete"})).is_err());
        let answer = decode(&completed(json!({"message":"Hi", "patch":"-x\n+y"}))).unwrap();
        assert_eq!(answer.patch.as_deref(), Some("-x\n+y"));
        assert_eq!(answer.cached_tokens, 128);
        let blank = decode(&completed(json!({"message":"Hi", "patch":"  "}))).unwrap();
        assert!(blank.patch.is_none());
    }

    #[test]
    fn repair_uses_current_buffer_and_preserves_the_validation_reason() {
        let req = request("def updated():\n    pass");
        let turn = repair_request(&req, "@@ line not found");
        let data: Value = serde_json::from_str(turn["content"].as_str().unwrap()).unwrap();
        assert_eq!(data["current_code"], req.code);
        assert_eq!(data["question"], req.message);
        assert_eq!(data["patch_error"], "@@ line not found");
        let message = rejected_patch_message("it changes more than 200 lines");
        assert!(message.contains("more than 200 lines"));
        assert!(!message.contains("did not match"));
    }

    #[test]
    fn checks_size_and_anchoring() {
        assert!(check("x = 1", "-x = 1\n+x = 2").is_ok());
        assert!(check("x = 1", "-y = 1\n+y = 2").is_err());
        let huge = "+a\n".repeat(MAX_CHANGED_LINES + 1);
        assert!(check("", &huge).is_err());
    }
}
