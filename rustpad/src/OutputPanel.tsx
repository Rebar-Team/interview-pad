import {
  Box,
  Flex,
  HStack,
  Icon,
  IconButton,
  Text,
  Textarea,
} from "@chakra-ui/react";
import { VscChevronDown, VscTerminal } from "react-icons/vsc";

import type { RunResult } from "./judge0";

export type OutputState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "error"; message: string }
  | { kind: "result"; result: RunResult };

type OutputPanelProps = {
  darkMode: boolean;
  state: OutputState;
  stdin: string;
  onChangeStdin: (value: string) => void;
  onClose: () => void;
};

// Judge0 status ids: 3 == Accepted (ran cleanly). Everything else is a
// compile error, runtime error, TLE, etc. and gets a red heading.
function statusColor(id: number): string {
  return id === 3 ? "green.400" : "red.400";
}

function OutputPanel({
  darkMode,
  state,
  stdin,
  onChangeStdin,
  onClose,
}: OutputPanelProps) {
  const mono = `"SFMono-Regular", Menlo, Consolas, monospace`;
  const bg = darkMode ? "#1e1e1e" : "#fbfbfb";
  const headerBg = darkMode ? "#252526" : "#f0f0f0";
  const border = darkMode ? "#333333" : "#e2e2e2";

  return (
    <Flex
      direction="column"
      h="100%"
      bgColor={bg}
      borderTop="1px solid"
      borderColor={border}
    >
      <HStack
        h={7}
        px={2}
        spacing={1}
        flexShrink={0}
        bgColor={headerBg}
        color={darkMode ? "#cccccc" : "#383838"}
        justify="space-between"
      >
        <HStack spacing={1.5}>
          <Icon as={VscTerminal} fontSize="sm" />
          <Text fontSize="xs" fontWeight="medium">
            Output
          </Text>
          {state.kind === "running" && (
            <Text fontSize="xs" color="#888888">
              running…
            </Text>
          )}
          {state.kind === "result" && (
            <Text fontSize="xs" color="#888888">
              {state.result.status.description}
              {state.result.time != null && ` · ${state.result.time}s`}
            </Text>
          )}
        </HStack>
        <IconButton
          aria-label="Collapse output"
          icon={<VscChevronDown />}
          size="xs"
          variant="ghost"
          onClick={onClose}
        />
      </HStack>

      <Box
        flex={1}
        minH={0}
        overflowY="auto"
        p={2}
        fontFamily={mono}
        fontSize="13px"
      >
        {state.kind === "idle" && (
          <Text color="#888888" fontSize="xs">
            Press Run to compile and execute the current pad.
          </Text>
        )}
        {state.kind === "error" && (
          <Text color="red.400" whiteSpace="pre-wrap">
            {state.message}
          </Text>
        )}
        {state.kind === "result" && <ResultView result={state.result} />}
      </Box>

      <Box flexShrink={0} borderTop="1px solid" borderColor={border} p={2}>
        <Text fontSize="10px" color="#888888" mb={1} textTransform="uppercase">
          stdin
        </Text>
        <Textarea
          rows={2}
          resize="vertical"
          value={stdin}
          onChange={(e) => onChangeStdin(e.target.value)}
          placeholder="Optional input passed to the program…"
          fontFamily={mono}
          fontSize="12px"
          bgColor={darkMode ? "#3c3c3c" : "white"}
          color={darkMode ? "#cbcaca" : "inherit"}
          borderColor={border}
        />
      </Box>
    </Flex>
  );
}

function Section({
  label,
  text,
  color,
}: {
  label: string;
  text: string;
  color?: string;
}) {
  return (
    <Box mb={2}>
      <Text fontSize="10px" color="#888888" mb={0.5} textTransform="uppercase">
        {label}
      </Text>
      <Text as="pre" whiteSpace="pre-wrap" color={color} m={0}>
        {text}
      </Text>
    </Box>
  );
}

function ResultView({ result }: { result: RunResult }) {
  const anyOutput =
    result.stdout || result.stderr || result.compile_output || result.message;
  return (
    <>
      <Text
        fontSize="xs"
        fontWeight="bold"
        color={statusColor(result.status.id)}
        mb={2}
      >
        {result.status.description}
      </Text>
      {result.compile_output && (
        <Section
          label="compile"
          text={result.compile_output}
          color="orange.400"
        />
      )}
      {result.stdout && <Section label="stdout" text={result.stdout} />}
      {result.stderr && (
        <Section label="stderr" text={result.stderr} color="red.400" />
      )}
      {result.message && !result.stderr && (
        <Section label="message" text={result.message} color="red.400" />
      )}
      {!anyOutput && (
        <Text color="#888888" fontSize="xs">
          (no output)
        </Text>
      )}
    </>
  );
}

export default OutputPanel;
