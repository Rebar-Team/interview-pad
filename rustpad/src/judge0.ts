// Judge0 integration for InterviewPad.
//
// The frontend talks to Judge0 over the same origin at `/judge0/*`; Caddy
// reverse-proxies that to the judge0 server container (see ../../Caddyfile).
// We resolve Judge0 language IDs at runtime from GET /judge0/languages rather
// than hardcoding them, because the numeric IDs drift between Judge0 versions.

export type Judge0Language = { id: number; name: string };

export type RunResult = {
  stdout: string | null;
  stderr: string | null;
  compile_output: string | null;
  message: string | null;
  time: string | null;
  memory: number | null;
  status: { id: number; description: string };
};

const JUDGE0_BASE = "/judge0";

// Map a Monaco editor language id to a matcher over Judge0 language *names*.
// When several Judge0 languages match (e.g. multiple Python versions), we keep
// the highest id, which is the newest bundled version.
const MATCHERS: Record<string, (name: string) => boolean> = {
  c: (n) => /^c\s*\(gcc/i.test(n),
  cpp: (n) => /^c\+\+/i.test(n),
  csharp: (n) => /^c#/i.test(n),
  clojure: (n) => /^clojure/i.test(n),
  dart: (n) => /^dart/i.test(n),
  elixir: (n) => /^elixir/i.test(n),
  fsharp: (n) => /^f#/i.test(n),
  go: (n) => /^go\s*\(/i.test(n),
  java: (n) => /^java\s*\(/i.test(n),
  javascript: (n) => /^javascript/i.test(n),
  kotlin: (n) => /^kotlin/i.test(n),
  lua: (n) => /^lua/i.test(n),
  "objective-c": (n) => /^objective-c/i.test(n),
  pascal: (n) => /^pascal/i.test(n),
  perl: (n) => /^perl/i.test(n),
  php: (n) => /^php/i.test(n),
  python: (n) => /^python\s*\(3/i.test(n) || /^python\s*\(/i.test(n),
  r: (n) => /^r\s*\(/i.test(n),
  ruby: (n) => /^ruby/i.test(n),
  rust: (n) => /^rust/i.test(n),
  scala: (n) => /^scala/i.test(n),
  shell: (n) => /^bash/i.test(n),
  sql: (n) => /^sql\s*\(|sqlite/i.test(n),
  swift: (n) => /^swift/i.test(n),
  typescript: (n) => /^typescript/i.test(n),
};

/** Monaco languages that have no Judge0 executor (markup, config, etc.). */
export function isRunnable(monacoLanguage: string): boolean {
  return monacoLanguage in MATCHERS;
}

let languagesCache: Promise<Judge0Language[]> | null = null;

function fetchLanguages(): Promise<Judge0Language[]> {
  if (!languagesCache) {
    languagesCache = fetch(`${JUDGE0_BASE}/languages`).then((res) => {
      if (!res.ok) throw new Error(`Judge0 /languages returned ${res.status}`);
      return res.json();
    });
  }
  return languagesCache;
}

async function resolveLanguageId(monacoLanguage: string): Promise<number> {
  const matcher = MATCHERS[monacoLanguage];
  if (!matcher) {
    throw new Error(`"${monacoLanguage}" can't be executed by Judge0.`);
  }
  const languages = await fetchLanguages();
  const matches = languages.filter((l) => matcher(l.name));
  if (matches.length === 0) {
    throw new Error(`No Judge0 runtime found for "${monacoLanguage}".`);
  }
  // Highest id == newest bundled version.
  return matches.reduce((a, b) => (a.id > b.id ? a : b)).id;
}

/**
 * Compile and run `source` in `monacoLanguage`. Uses Judge0's synchronous
 * mode (wait=true), which is enabled by default on self-hosted instances.
 */
export async function runCode(
  monacoLanguage: string,
  source: string,
  stdin = "",
): Promise<RunResult> {
  const languageId = await resolveLanguageId(monacoLanguage);
  const res = await fetch(
    `${JUDGE0_BASE}/submissions?base64_encoded=false&wait=true`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source_code: source,
        language_id: languageId,
        stdin,
      }),
    },
  );
  if (!res.ok) {
    throw new Error(`Judge0 submission failed (${res.status}).`);
  }
  return res.json();
}
