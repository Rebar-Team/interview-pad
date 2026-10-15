use super::{memory::Message, ChatRequest};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Edit {
    pub before: String,
    pub after: String,
}

impl Edit {
    pub fn valid_for(&self, code: &str) -> bool {
        let target_exists = if self.before.is_empty() {
            code.is_empty()
        } else {
            code.contains(&self.before) && code.find(&self.before) == code.rfind(&self.before)
        };
        target_exists
            && self.before != self.after
            && self.before.len() + self.after.len() <= 16_000
            && self.before.lines().count() + self.after.lines().count() <= 200
    }
}

#[derive(Deserialize, Serialize)]
pub(super) struct Answer {
    pub message: String,
    pub edit: Option<Edit>,
    #[serde(default)]
    pub cached_tokens: u64,
}

pub(super) struct LunaClient {
    key: Option<String>,
    http: reqwest::Client,
}

impl LunaClient {
    pub fn new(key: Option<String>) -> Self {
        Self {
            key,
            http: reqwest::Client::builder()
                .https_only(true)
                .timeout(Duration::from_secs(60))
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
        let body = payload(history, request, instructions);
        let response = self
            .http
            .post("https://api.openai.com/v1/responses")
            .bearer_auth(key)
            .json(&body)
            .send()
            .await
            .map_err(|_| "OpenAI request failed or timed out")?;
        if !response.status().is_success() {
            return Err(format!(
                "OpenAI returned HTTP {}. Check model access and account limits.",
                response.status().as_u16()
            ));
        }
        let data: Value = response
            .json()
            .await
            .map_err(|_| "Invalid OpenAI response")?;
        decode(data, &request.code)
    }
}

fn payload(history: Vec<Message>, request: &ChatRequest, instructions: String) -> Value {
    let mut input = serde_json::to_value(history)
        .unwrap()
        .as_array()
        .unwrap()
        .clone();
    input.push(json!({"role": "user", "content": json!({
        "question": request.message, "current_code": request.code, "language": request.language,
    }).to_string()}));
    json!({
        "model": "gpt-6-luna", "store": false, "instructions": instructions,
        "input": input, "reasoning": {"effort": "low"}, "max_output_tokens": 8000,
        "text": {"format": {"type": "json_schema", "name": "pad_reply", "strict": true,
            "schema": {"type": "object", "additionalProperties": false,
                "properties": {"message": {"type": "string"}, "edit": {"anyOf": [
                    {"type": "null"}, {"type": "object", "additionalProperties": false,
                     "properties": {"before": {"type": "string"}, "after": {"type": "string"}},
                     "required": ["before", "after"]}]}}, "required": ["message", "edit"]}}}
    })
}

fn decode(data: Value, code: &str) -> Result<Answer, String> {
    if data["status"] != "completed" {
        return Err("Luna did not finish; try a smaller request".into());
    }
    let text: String = data["output"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|item| item["content"].as_array().into_iter().flatten())
        .filter(|part| part["type"] == "output_text")
        .filter_map(|part| part["text"].as_str())
        .collect();
    let mut answer: Answer =
        serde_json::from_str(&text).map_err(|_| "Luna returned an invalid reply")?;
    if answer.message.len() > 8000 {
        return Err("Luna reply was too long".into());
    }
    if answer
        .edit
        .as_ref()
        .map(|e| !e.valid_for(code))
        .unwrap_or(false)
    {
        answer.edit = None;
        answer.message = "No edit was applied. The proposal was withheld because it exceeded 200 combined lines / 16 KB or did not uniquely match the current buffer. Ask for a narrower, targeted edit.".into();
    }
    answer.cached_tokens = data["usage"]["input_tokens_details"]["cached_tokens"]
        .as_u64()
        .unwrap_or(0);
    Ok(answer)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_ambiguous_large_and_empty_edits() {
        for (before, after, code) in [
            ("x", "y", "xx"),
            ("aa", "y", "aaa"),
            ("", "y", "existing code"),
            ("x", "x", "x"),
        ] {
            assert!(!Edit {
                before: before.into(),
                after: after.into()
            }
            .valid_for(code));
        }
        assert!(!Edit {
            before: "x".into(),
            after: "y".repeat(16_000)
        }
        .valid_for("x"));
        assert!(Edit {
            before: "x".into(),
            after: "y".into()
        }
        .valid_for("x"));
    }
    #[test]
    fn permits_larger_targeted_edits_but_keeps_bounds() {
        let edit = Edit {
            before: "old".into(),
            after: "code\n".repeat(80),
        };
        assert!(edit.valid_for("old"));
        assert!(!Edit {
            before: "old".into(),
            after: "code\n".repeat(200)
        }
        .valid_for("old"));
    }

    #[test]
    fn permits_initial_code_only_in_an_empty_pad() {
        let edit = Edit {
            before: String::new(),
            after: "class Board:\n    pass".into(),
        };
        assert!(edit.valid_for(""));
        assert!(!edit.valid_for("user typed"));
        assert!(!Edit {
            before: String::new(),
            after: String::new()
        }
        .valid_for(""));
    }

    #[test]
    fn request_has_no_tools_or_provider_conversation_storage() {
        let request = ChatRequest {
            pad_id: "p".into(),
            message: "help".into(),
            code: "x".into(),
            language: "python".into(),
        };
        let body = payload(vec![], &request, "test instructions".into());
        assert_eq!(body["model"], "gpt-6-luna");
        assert_eq!(body["store"], false);
        assert!(body.get("tools").is_none());
        assert_eq!(body["instructions"], "test instructions");
    }
    #[test]
    fn refuses_incomplete_and_filters_invalid_proposal() {
        assert!(decode(json!({"status":"incomplete"}), "x").is_err());
        let answer = decode(json!({"status":"completed", "output":[{"content":[{
            "type":"output_text", "text":json!({"message":"Hi", "edit":{"before":"missing", "after":"y"}}).to_string()
        }]}], "usage":{"input_tokens_details":{"cached_tokens":128}}}), "x").unwrap();
        assert!(answer.edit.is_none());
        assert_eq!(answer.cached_tokens, 128);
    }
}
