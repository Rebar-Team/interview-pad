import {
  Avatar,
  AvatarGroup,
  Box,
  Button,
  Flex,
  HStack,
  IconButton,
  Input,
  Menu,
  MenuButton,
  MenuItem,
  MenuList,
  Popover,
  PopoverArrow,
  PopoverBody,
  PopoverContent,
  PopoverTrigger,
  Spinner,
  Text,
  Tooltip,
  useToast,
} from "@chakra-ui/react";
import Editor from "@monaco-editor/react";
import { editor } from "monaco-editor/esm/vs/editor/editor.api";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  VscChevronDown,
  VscColorMode,
  VscLink,
  VscPlay,
  VscTerminal,
} from "react-icons/vsc";
import useLocalStorageState from "use-local-storage-state";

import Terminal, { TerminalHandle, isRunnable } from "./Terminal";
import animals from "./animals.json";
import Rustpad, { UserInfo } from "./rustpad";
import useHash from "./useHash";

// The only languages the runner (ptyd) can execute — a curated list, not the
// full Monaco set. `monaco` is the Monaco language id used for highlighting.
const LANGUAGES: { id: string; label: string }[] = [
  { id: "python", label: "Python 3" },
  { id: "javascript", label: "JavaScript" },
  { id: "typescript", label: "TypeScript" },
  { id: "java", label: "Java" },
  { id: "go", label: "Go" },
  { id: "c", label: "C" },
  { id: "cpp", label: "C++" },
];

function languageLabel(id: string): string {
  return LANGUAGES.find((l) => l.id === id)?.label ?? id;
}

function getWsUri(id: string) {
  let url = new URL(`api/socket/${id}`, window.location.href);
  url.protocol = url.protocol == "https:" ? "wss:" : "ws:";
  return url.href;
}

function generateName() {
  return "Anonymous " + animals[Math.floor(Math.random() * animals.length)];
}

function generateHue() {
  return Math.floor(Math.random() * 360);
}

function userColor(hue: number) {
  return `hsl(${hue}, 90%, 60%)`;
}

function App() {
  const toast = useToast();
  const [language, setLanguage] = useState("python");
  const [connection, setConnection] = useState<
    "connected" | "disconnected" | "desynchronized"
  >("disconnected");
  const [users, setUsers] = useState<Record<number, UserInfo>>({});
  const [name, setName] = useLocalStorageState("name", {
    defaultValue: generateName,
  });
  const [hue, setHue] = useLocalStorageState("hue", { defaultValue: generateHue });
  const [editor, setEditor] = useState<editor.IStandaloneCodeEditor>();
  const [darkMode, setDarkMode] = useLocalStorageState("darkMode", {
    defaultValue: true,
  });
  const rustpad = useRef<Rustpad>();
  const id = useHash();

  const termRef = useRef<TerminalHandle>(null);
  const [showTerminal, setShowTerminal] = useState(true);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (editor?.getModel()) {
      const model = editor.getModel()!;
      model.setValue("");
      model.setEOL(0); // LF
      rustpad.current = new Rustpad({
        uri: getWsUri(id),
        editor,
        onConnected: () => setConnection("connected"),
        onDisconnected: () => setConnection("disconnected"),
        onDesynchronized: () => {
          setConnection("desynchronized");
          toast({
            title: "Desynchronized with server",
            description: "Please save your work and refresh the page.",
            status: "error",
            duration: null,
          });
        },
        onChangeLanguage: (language) => setLanguage(language),
        onChangeUsers: setUsers,
      });
      return () => {
        rustpad.current?.dispose();
        rustpad.current = undefined;
      };
    }
  }, [id, editor, toast, setUsers]);

  useEffect(() => {
    if (connection === "connected") {
      rustpad.current?.setInfo({ name, hue });
    }
  }, [connection, name, hue]);

  function handleLanguageChange(lang: string) {
    setLanguage(lang);
    rustpad.current?.setLanguage(lang);
  }

  const handleRun = useCallback(() => {
    const model = editor?.getModel();
    if (!model) return;
    if (!isRunnable(language)) {
      toast({
        title: "Not runnable",
        description: `Pick a runnable language (current: ${languageLabel(language)}).`,
        status: "warning",
        duration: 3000,
        isClosable: true,
      });
      return;
    }
    setShowTerminal(true);
    termRef.current?.run(language, model.getValue());
  }, [editor, language, toast]);

  const handleRunRef = useRef(handleRun);
  handleRunRef.current = handleRun;
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        handleRunRef.current();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  async function handleShare() {
    await navigator.clipboard.writeText(`${window.location.origin}/#${id}`);
    toast({
      title: "Link copied",
      description: "Share it with your candidate to start pairing.",
      status: "success",
      duration: 2500,
      isClosable: true,
    });
  }

  // Theme tokens.
  const chromeBg = darkMode ? "#1e1e1e" : "#ffffff";
  const barBg = darkMode ? "#181818" : "#f7f7f8";
  const border = darkMode ? "#2b2b2b" : "#e4e4e7";
  const fg = darkMode ? "#e6e6e6" : "#1e1e1e";
  const subtle = darkMode ? "#9a9a9a" : "#6b6b70";
  const connColor =
    connection === "connected"
      ? "#39d353"
      : connection === "desynchronized"
        ? "#f0b429"
        : "#f04",
    others = Object.entries(users);

  return (
    <Flex direction="column" h="100vh" overflow="hidden" bgColor={chromeBg} color={fg}>
      {/* Toolbar */}
      <Flex
        align="center"
        flexShrink={0}
        h="52px"
        px={3}
        gap={3}
        bgColor={barBg}
        borderBottom="1px solid"
        borderColor={border}
      >
        {/* Brand */}
        <HStack spacing={1.5} pr={1}>
          <img
            src="/rebar-logo.svg"
            alt="Rebar"
            style={{
              height: 18,
              filter: darkMode ? "brightness(0) invert(1)" : "none",
            }}
          />
          <Text fontWeight="bold" fontSize="lg" letterSpacing="-0.02em">
            Pad
          </Text>
        </HStack>

        <Box w="1px" h="24px" bgColor={border} />

        {/* Language picker (curated) */}
        <Menu>
          <MenuButton
            as={Button}
            size="sm"
            variant="ghost"
            rightIcon={<VscChevronDown />}
            color={fg}
            _hover={{ bg: darkMode ? "#2b2b2b" : "gray.100" }}
            _active={{ bg: darkMode ? "#2b2b2b" : "gray.100" }}
            fontWeight="medium"
          >
            {languageLabel(language)}
          </MenuButton>
          <MenuList bg={darkMode ? "#252526" : "white"} borderColor={border} minW="160px">
            {LANGUAGES.map((l) => (
              <MenuItem
                key={l.id}
                bg="transparent"
                color={fg}
                _hover={{ bg: darkMode ? "#2f6feb33" : "blue.50" }}
                fontWeight={l.id === language ? "semibold" : "normal"}
                onClick={() => handleLanguageChange(l.id)}
              >
                {l.label}
              </MenuItem>
            ))}
          </MenuList>
        </Menu>

        <Box flex={1} />

        {/* Connection status */}
        <Tooltip label={connection} textTransform="capitalize">
          <HStack spacing={1.5}>
            <Box w="8px" h="8px" borderRadius="full" bgColor={connColor} />
            <Text fontSize="xs" color={subtle} display={{ base: "none", md: "block" }}>
              {connection === "connected" ? "Live" : connection}
            </Text>
          </HStack>
        </Tooltip>

        {/* Presence */}
        <HStack spacing="-8px">
          <Popover placement="bottom-end">
            <PopoverTrigger>
              <Avatar
                size="sm"
                name={name}
                bg={userColor(hue)}
                color="white"
                cursor="pointer"
                border="2px solid"
                borderColor={barBg}
                zIndex={others.length + 1}
              />
            </PopoverTrigger>
            <PopoverContent w="240px" bg={darkMode ? "#252526" : "white"} borderColor={border}>
              <PopoverArrow bg={darkMode ? "#252526" : "white"} />
              <PopoverBody>
                <Text fontSize="xs" color={subtle} mb={1}>
                  Your name
                </Text>
                <Input
                  size="sm"
                  value={name}
                  onChange={(e) => e.target.value.length > 0 && setName(e.target.value)}
                  bg={darkMode ? "#1e1e1e" : "white"}
                  borderColor={border}
                  color={fg}
                />
                <Button
                  mt={2}
                  size="xs"
                  w="full"
                  variant="outline"
                  borderColor={border}
                  color={fg}
                  onClick={() => setHue(generateHue())}
                >
                  Change color
                </Button>
              </PopoverBody>
            </PopoverContent>
          </Popover>
          {others.slice(0, 4).map(([uid, info]) => (
            <Tooltip key={uid} label={info.name}>
              <Avatar
                size="sm"
                name={info.name}
                bg={userColor(info.hue)}
                color="white"
                border="2px solid"
                borderColor={barBg}
              />
            </Tooltip>
          ))}
          {others.length > 4 && (
            <Avatar size="sm" name={`+ ${others.length - 4}`} bg={subtle} color="white" border="2px solid" borderColor={barBg} />
          )}
        </HStack>

        {/* Share */}
        <Tooltip label="Copy invite link">
          <Button
            size="sm"
            variant="outline"
            leftIcon={<VscLink />}
            borderColor={border}
            color={fg}
            _hover={{ bg: darkMode ? "#2b2b2b" : "gray.100" }}
            onClick={handleShare}
          >
            Share
          </Button>
        </Tooltip>

        {/* Terminal toggle */}
        <Tooltip label={showTerminal ? "Hide terminal" : "Show terminal"}>
          <IconButton
            aria-label="Toggle terminal"
            icon={<VscTerminal />}
            size="sm"
            variant="ghost"
            color={showTerminal ? "#2f81f7" : subtle}
            _hover={{ bg: darkMode ? "#2b2b2b" : "gray.100" }}
            onClick={() => setShowTerminal((v) => !v)}
          />
        </Tooltip>

        {/* Dark mode */}
        <Tooltip label="Toggle theme">
          <IconButton
            aria-label="Toggle theme"
            icon={<VscColorMode />}
            size="sm"
            variant="ghost"
            color={subtle}
            _hover={{ bg: darkMode ? "#2b2b2b" : "gray.100" }}
            onClick={() => setDarkMode(!darkMode)}
          />
        </Tooltip>

        {/* Run */}
        <Button
          size="sm"
          px={5}
          minW="90px"
          colorScheme="green"
          leftIcon={running ? <Spinner size="xs" /> : <VscPlay />}
          isDisabled={!isRunnable(language)}
          onClick={handleRun}
          title={
            isRunnable(language)
              ? "Run (⌘/Ctrl + Enter)"
              : `${languageLabel(language)} is not runnable`
          }
        >
          {running ? "Running" : "Run"}
        </Button>
      </Flex>

      {/* Editor + terminal */}
      <Flex flex={1} minH={0}>
        <Box flex={showTerminal ? 3 : 1} minW={0} h="100%">
          <Editor
            theme={darkMode ? "vs-dark" : "vs"}
            language={language}
            options={{
              automaticLayout: true,
              fontSize: 14,
              minimap: { enabled: false },
              padding: { top: 12 },
              scrollBeyondLastLine: false,
            }}
            onMount={(ed) => setEditor(ed)}
          />
        </Box>
        {showTerminal && (
          <>
            <Box w="1px" bgColor={border} />
            <Box flex={2} minW={0} h="100%">
              <Terminal
                ref={termRef}
                padId={id}
                darkMode={darkMode}
                onClose={() => setShowTerminal(false)}
                onRunningChange={setRunning}
              />
            </Box>
          </>
        )}
      </Flex>
    </Flex>
  );
}

export default App;
