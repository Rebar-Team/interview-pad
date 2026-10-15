import { Box, Button, Flex, Text, Textarea } from "@chakra-ui/react";
import type { editor } from "monaco-editor/esm/vs/editor/editor.api";
import { useEffect, useRef, useState } from "react";

import { Answer, AssistantClient } from "./client";
import { replacement } from "./proposal";

type Turn = {
  question: string;
  answer?: Answer;
  snapshot: string;
  applied?: boolean;
};
type Props = {
  padId: string;
  language: string;
  editor?: editor.IStandaloneCodeEditor;
  dark: boolean;
};

export default function AssistantPanel({
  padId,
  language,
  editor: ed,
  dark,
}: Props) {
  const [client] = useState(() => new AssistantClient());
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const active = useRef(true);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      client.cancel();
    };
  }, [client]);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" });
  }, [turns, busy]);

  async function send() {
    const question = draft.trim(),
      snapshot = ed?.getValue();
    if (!question || snapshot === undefined || busy) return;
    setBusy(true);
    setError("");
    setDraft("");
    setTurns((items) => [...items.slice(-5), { question, snapshot }]);
    try {
      const answer = await client.request("chat", {
        padId,
        language,
        code: snapshot,
        message: question,
      });
      if (active.current)
        setTurns((items) =>
          items.map((t, i) => (i === items.length - 1 ? { ...t, answer } : t)),
        );
    } catch (e) {
      if (active.current)
        setError(
          e instanceof Error ? e.message : "Interview Assistant unavailable.",
        );
    } finally {
      if (active.current) setBusy(false);
    }
  }

  async function clear() {
    setBusy(true);
    setError("");
    try {
      await client.request("reset", { padId });
      if (active.current) setTurns([]);
    } catch (e) {
      if (active.current) setError((e as Error).message);
    } finally {
      if (active.current) setBusy(false);
    }
  }

  function apply(turn: Turn, index: number) {
    try {
      const model = ed?.getModel(),
        edit = turn.answer?.edit;
      if (!ed || !model || !edit) return;
      const patch = replacement(model.getValue(), turn.snapshot, edit);
      const a = model.getPositionAt(patch.start),
        b = model.getPositionAt(patch.end);
      ed.pushUndoStop();
      ed.executeEdits("luna", [
        {
          range: {
            startLineNumber: a.lineNumber,
            startColumn: a.column,
            endLineNumber: b.lineNumber,
            endColumn: b.column,
          },
          text: patch.text,
        },
      ]);
      ed.pushUndoStop();
      setTurns((items) =>
        items.map((t, i) => (i === index ? { ...t, applied: true } : t)),
      );
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <Flex
      as="aside"
      aria-label="Rebar Interview Assistant"
      direction="column"
      w="360px"
      minW="300px"
      maxW="45vw"
      h="100%"
      borderLeftWidth="1px"
      borderColor={dark ? "#333" : "gray.200"}
      bg={dark ? "#181818" : "gray.50"}
    >
      <Flex p={4} align="center" justify="space-between">
        <Text fontSize="sm" fontWeight="semibold">
          Rebar Interview Assistant
        </Text>
        <Button size="xs" variant="outline" onClick={clear} isDisabled={busy}>
          Clear chat
        </Button>
      </Flex>
      <Box flex={1} minH={0} overflowY="auto" px={4}>
        {turns.map((turn, i) => (
          <Box key={i} mb={5}>
            <Text fontSize="xs" opacity={0.6} mb={1}>
              You
            </Text>
            <Text fontSize="sm" whiteSpace="pre-wrap" overflowWrap="anywhere">
              {turn.question}
            </Text>
            {turn.answer && (
              <Box mt={4}>
                <Text fontSize="xs" opacity={0.6} mb={1}>
                  Rebar Interview Assistant
                </Text>
                <Text
                  fontSize="sm"
                  whiteSpace="pre-wrap"
                  overflowWrap="anywhere"
                >
                  {turn.answer.message}
                </Text>
                {turn.answer.edit && (
                  <Box mt={3} p={3} borderWidth="1px" borderRadius="md">
                    <Text fontSize="xs" mb={1}>
                      Replace
                    </Text>
                    <Box
                      as="pre"
                      fontSize="xs"
                      whiteSpace="pre-wrap"
                      overflowWrap="anywhere"
                      color="red.300"
                    >
                      {turn.answer.edit.before}
                    </Box>
                    <Text fontSize="xs" my={1}>
                      With
                    </Text>
                    <Box
                      as="pre"
                      fontSize="xs"
                      whiteSpace="pre-wrap"
                      overflowWrap="anywhere"
                      color="green.300"
                    >
                      {turn.answer.edit.after || "(delete)"}
                    </Box>
                    <Button
                      size="xs"
                      mt={3}
                      onClick={() => apply(turn, i)}
                      isDisabled={turn.applied || !ed}
                    >
                      {turn.applied ? "Applied" : "Apply edit"}
                    </Button>
                  </Box>
                )}
              </Box>
            )}
          </Box>
        ))}
        {busy && (
          <Text fontSize="sm" opacity={0.6}>
            Working…
          </Text>
        )}
        <div ref={end} />
      </Box>
      <Box p={4}>
        {error && (
          <Text role="alert" fontSize="xs" color="red.300" mb={2}>
            {error}
          </Text>
        )}
        <Textarea
          aria-label="Ask Rebar Interview Assistant"
          placeholder="Ask Rebar Interview Assistant"
          value={draft}
          rows={3}
          resize="none"
          fontSize="sm"
          maxLength={2000}
          isDisabled={busy}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <Flex mt={2} justify="flex-end" align="center">
          <Button
            size="sm"
            onClick={send}
            isDisabled={!draft.trim() || busy || !ed}
          >
            Send
          </Button>
        </Flex>
      </Box>
    </Flex>
  );
}
