// Language names match WakaTime's own vocabulary (GET /api/v1/program_languages),
// so a heartbeat's language joins the same series that file heartbeats create.
const BY_EXTENSION = new Map(Object.entries({
  js: "JavaScript", mjs: "JavaScript", cjs: "JavaScript", jsx: "JavaScript",
  ts: "TypeScript", mts: "TypeScript", cts: "TypeScript", tsx: "TypeScript",
  py: "Python", pyi: "Python", pyw: "Python",
  rb: "Ruby", rs: "Rust", go: "Go", java: "Java", kt: "Kotlin", kts: "Kotlin",
  scala: "Scala", sc: "Scala", groovy: "Groovy",
  cs: "C#", fs: "F#", fsi: "F#", fsx: "F#",
  c: "C", cc: "C++", cpp: "C++", cxx: "C++", hpp: "C++", hh: "C++", hxx: "C++", ino: "C++",
  m: "Objective-C", mm: "Objective-C++", swift: "Swift",
  php: "PHP", pl: "Perl", pm: "Perl", lua: "Lua", r: "R", jl: "Julia", dart: "Dart",
  hs: "Haskell", ex: "Elixir", exs: "Elixir", erl: "Erlang", hrl: "Erlang",
  clj: "Clojure", cljs: "Clojure", cljc: "Clojure",
  ml: "OCaml", mli: "OCaml", nim: "Nim", zig: "Zig", sol: "Solidity",
  sh: "Shell", bash: "Shell", zsh: "Shell", ksh: "Shell", fish: "fish",
  ps1: "PowerShell", psm1: "PowerShell", psd1: "PowerShell", bat: "Batchfile", cmd: "Batchfile",
  sql: "SQL", html: "HTML", htm: "HTML", xhtml: "HTML",
  css: "CSS", scss: "SCSS", sass: "Sass", less: "Less", styl: "Stylus",
  vue: "Vue", svelte: "Svelte", astro: "Astro",
  tex: "TeX", bib: "BibTeX", proto: "Protocol Buffer", graphql: "GraphQL", gql: "GraphQL",
  tf: "HCL", tfvars: "HCL", hcl: "HCL", nix: "Nix",
  ipynb: "Jupyter Notebook", vim: "Vim Script", asm: "Assembly", s: "Assembly",
  wat: "WebAssembly", wast: "WebAssembly", glsl: "GLSL", wgsl: "WGSL",
  prisma: "Prisma", rego: "Open Policy Agent", cu: "Cuda", metal: "Metal",
  gleam: "Gleam", rkt: "Racket", scm: "Scheme", lisp: "Common Lisp", el: "Emacs Lisp",
  prolog: "Prolog", raku: "Raku", cr: "Crystal", d: "D", vala: "Vala", elm: "Elm",
  purs: "PureScript", res: "ReScript", re: "Reason", lean: "Lean 4", idr: "Idris", agda: "Agda",
  f90: "Fortran Free Form", f95: "Fortran Free Form", f03: "Fortran Free Form", f08: "Fortran Free Form",
  pas: "Pascal", adb: "Ada", ads: "Ada", cob: "COBOL", matlab: "MATLAB", wl: "Wolfram Language",
  do: "Stata", sas: "SAS", tcl: "Tcl", gd: "GDScript", vb: "Visual Basic .NET",
}));

const CANONICAL_NAMES = new Map([...new Set(BY_EXTENSION.values())].map((name) => [name.toLowerCase(), name]));

export function canonicalLanguage(value) {
  return typeof value === "string" ? CANONICAL_NAMES.get(value.trim().toLowerCase()) ?? null : null;
}

// Build products and vendored trees usually hold more files than the sources,
// so they must not decide the project's language.
const IGNORED_DIRECTORIES = new Set([
  "node_modules", "vendor", "third_party", "third-party", "dist", "build", "out",
  "target", "coverage", ".next", ".nuxt", "__pycache__",
  "pods", "carthage", ".build", ".swiftpm", "deriveddata", ".xcbuild", "sourcepackages",
]);

const GENERATED = /(?:\.d\.[cm]?ts|\.(?:min|bundle|generated)\.[^./]+)$/i;
const IGNORED_FILES = new Set(["package.swift"]);

// Headers cannot tell C, C++ and Objective-C apart, so they are not counted.
// Counting them would turn a Swift or Objective-C project with bridge headers into C.
export function analyzeLanguage(files) {
  if (typeof files !== "string" || !files) return { language: null, reason: "none", counts: {} };
  const counts = new Map();
  for (const path of files.split("\0")) {
    if (!path) continue;
    const parts = path.split("/");
    if (parts.slice(0, -1).some((part) => IGNORED_DIRECTORIES.has(part.toLowerCase()))) continue;
    const name = parts[parts.length - 1].toLowerCase();
    if (GENERATED.test(name) || IGNORED_FILES.has(name)) continue;
    const dot = name.lastIndexOf(".");
    if (dot < 1) continue;
    const language = BY_EXTENSION.get(name.slice(dot + 1));
    if (language) counts.set(language, (counts.get(language) ?? 0) + 1);
  }
  let best = null, tied = false;
  for (const [language, count] of counts) {
    if (!best || count > best.count) { best = { language, count }; tied = false; }
    else if (count === best.count) tied = true;
  }
  return {
    language: best && !tied ? best.language : null,
    reason: !best ? "none" : tied ? "ambiguous" : null,
    counts: Object.fromEntries(counts),
  };
}

export function detectLanguage(files) {
  return analyzeLanguage(files).language;
}