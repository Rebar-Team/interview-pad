use serde::Serialize;
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

/// History kept per session and room. Fits the largest legal turn (2 KB
/// question, 8 KB reply, 16 KB proposed patch) with room for earlier ones.
const MAX_BYTES: usize = 64_000;

#[derive(Clone, Serialize)]
pub(super) struct Message {
    pub role: &'static str,
    pub content: String,
}

struct Entry {
    touched: Instant,
    messages: Vec<Message>,
}

/// Short-term assistant conversation memory, not a response/prompt cache.
#[derive(Default)]
pub(super) struct Memory {
    entries: HashMap<String, Entry>,
}

impl Memory {
    pub fn read(&mut self, key: &str, now: Instant) -> Vec<Message> {
        self.evict(now);
        match self.entries.get_mut(key) {
            Some(entry) => {
                entry.touched = now;
                entry.messages.clone()
            }
            None => Vec::new(),
        }
    }

    pub fn remember(&mut self, key: String, question: String, answer: String, now: Instant) {
        self.evict(now);
        if !self.entries.contains_key(&key) && self.entries.len() >= 64 {
            if let Some(oldest) = self
                .entries
                .iter()
                .min_by_key(|(_, e)| e.touched)
                .map(|(k, _)| k.clone())
            {
                self.entries.remove(&oldest);
            }
        }
        let entry = self.entries.entry(key).or_insert_with(|| Entry {
            touched: now,
            messages: vec![],
        });
        entry.touched = now;
        entry.messages.extend([
            Message {
                role: "user",
                content: question,
            },
            Message {
                role: "assistant",
                content: answer,
            },
        ]);
        while entry.messages.len() > 12
            || entry
                .messages
                .iter()
                .map(|m| m.content.len())
                .sum::<usize>()
                > MAX_BYTES
        {
            entry.messages.drain(..2);
        }
    }

    pub fn clear(&mut self, key: &str) {
        self.entries.remove(key);
    }

    pub fn evict(&mut self, now: Instant) {
        self.entries
            .retain(|_, e| now.duration_since(e.touched) < Duration::from_secs(1800));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounded_isolated_and_expiring() {
        let now = Instant::now();
        let mut memory = Memory::default();
        for i in 0..10 {
            memory.remember("browser:pad".into(), i.to_string(), "reply".into(), now);
        }
        assert_eq!(memory.read("browser:pad", now).len(), 12);
        assert!(memory.read("other:pad", now).is_empty());
        assert!(memory.read("browser:other", now).is_empty());
        assert!(memory
            .read("browser:pad", now + Duration::from_secs(1800))
            .is_empty());
    }

    #[test]
    fn size_capacity_and_clear() {
        let mut memory = Memory::default();
        let now = Instant::now();
        for i in 0..65 {
            memory.remember(
                i.to_string(),
                "q".into(),
                "a".into(),
                now + Duration::from_millis(i),
            );
        }
        assert_eq!(memory.entries.len(), 64);
        assert!(!memory.entries.contains_key("0"));
        memory.clear("1");
        assert!(!memory.entries.contains_key("1"));
        memory.remember("big".into(), "q".repeat(MAX_BYTES + 1), "a".into(), now);
        assert!(memory.read("big", now).is_empty());
    }
}
