import { expect, test } from "bun:test";
import { detectLanguage } from "../src/language.mjs";

const files = (...list) => list.map((file) => `${file}\0`).join("");

test("picks the dominant tracked language and ignores documentation and build output", () => {
  expect(detectLanguage(files("src/app.ts", "src/view.tsx", "src/util.ts", "web/main.js",
    "README.md", "package.json", "dist/bundle.js", "src/types.d.ts", "src/lib.min.js"))).toBe("TypeScript");
  expect(detectLanguage(files("Cargo.toml", "src/main.rs", "src/cache.rs", "docs/guide.md"))).toBe("Rust");
  expect(detectLanguage(files("pkg/server.go", "go.mod", "vendor/legacy.c"))).toBe("Go");
});

test("recognizes Swift and ignores Apple dependency and build trees", () => {
  expect(detectLanguage(files("Sources/App.swift", "Sources/View.SWIFT"))).toBe("Swift");
  expect(detectLanguage(files("App/App.swift", "Pods/Legacy/a.m", "Pods/Legacy/b.m"))).toBe("Swift");
  expect(detectLanguage(files("Sources/App.swift", ".build/checkouts/CDep/a.c", ".build/checkouts/CDep/b.c"))).toBe("Swift");
  expect(detectLanguage(files("App/App.swift", "DerivedData/Build/a.m", "Carthage/b.c"))).toBe("Swift");
});

test("does not let headers create or replace a language", () => {
  expect(detectLanguage(files("src/a.c", "include/a.h", "include/b.h"))).toBe("C");
  expect(detectLanguage(files("src/a.cpp", "include/a.hpp", "include/b.h"))).toBe("C++");
  expect(detectLanguage(files("Sources/App.swift", "Sources/Bridge.h", "Sources/Constants.h"))).toBe("Swift");
  expect(detectLanguage(files("include/only.h"))).toBeNull();
});

test("returns nothing when no tracked file carries a recognized language", () => {
  for (const value of ["", "README.md\0", "data.json\0config.yml\0", "Package.swift\0", null, 7]) {
    expect(detectLanguage(value)).toBeNull();
  }
});

test("returns nothing for an ambiguous tie", () => {
  expect(detectLanguage(files("a.py", "b.rs"))).toBeNull();
  expect(detectLanguage(files("b.rs", "a.py"))).toBeNull();
});
