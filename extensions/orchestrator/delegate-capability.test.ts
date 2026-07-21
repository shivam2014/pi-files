import { describe, it, expect } from "vitest";
import { validateTaskCapabilities } from "./delegate-pipeline";

describe("A2 capability-aware validation", () => {
  it("warns when researcher is told to write a file", () => {
    const r = validateTaskCapabilities("researcher", "write file X");
    expect(r.ok).toBe(false);
    expect(r.warning).toMatch(/cannot/i);
  });
  it("allows scout to find files (read/find in its toolset)", () => {
    const r = validateTaskCapabilities("scout", "find all files that import foo");
    expect(r.ok).toBe(true);
  });
  it("allows researcher to research docs (no write/bash needed)", () => {
    const r = validateTaskCapabilities("researcher", "research the docs about X");
    expect(r.ok).toBe(true);
  });
  it("warns when a read-only specialist is told to edit", () => {
    const r = validateTaskCapabilities("reviewer", "edit the config file");
    expect(r.ok).toBe(false);
  });
});

describe("web_search pattern specificity (no false positives)", () => {
  it("does NOT warn scout when task says 'search the codebase'", () => {
    const r = validateTaskCapabilities("scout", "search the codebase for imports");
    expect(r.ok).toBe(true);
  });

  it("does NOT warn reviewer when task says 'search for pattern'", () => {
    const r = validateTaskCapabilities("reviewer", "search for the error pattern in logs");
    expect(r.ok).toBe(true);
  });

  it("does NOT warn coder when task says 'search all files'", () => {
    const r = validateTaskCapabilities("coder", "search all files for the TODO comment");
    expect(r.ok).toBe(true);
  });

  it("does NOT warn scout when task says 'fetch the data from stdin'", () => {
    const r = validateTaskCapabilities("scout", "fetch the data from stdin and parse it");
    expect(r.ok).toBe(true);
  });

  it("does NOT warn reviewer when task says 'download the npm package'", () => {
    const r = validateTaskCapabilities("reviewer", "download the npm package and inspect");
    expect(r.ok).toBe(true);
  });

  it("does NOT warn writer when task says 'search for similar docs'", () => {
    const r = validateTaskCapabilities("writer", "search for similar docs in the vault");
    expect(r.ok).toBe(true);
  });

  it("does NOT warn coder when task says 'scrape the log file'", () => {
    const r = validateTaskCapabilities("coder", "scrape the log file for errors");
    expect(r.ok).toBe(true);
  });
});

describe("web_search true positives (must warn)", () => {
  it("warns scout when task says 'search the web'", () => {
    const r = validateTaskCapabilities("scout", "search the web for documentation about X");
    expect(r.ok).toBe(false);
    expect(r.warning).toMatch(/web_search/);
  });

  it("warns scout when task says 'search online'", () => {
    const r = validateTaskCapabilities("scout", "search online for the latest API changes");
    expect(r.ok).toBe(false);
    expect(r.warning).toMatch(/web_search/);
  });

  it("warns scout when task says 'search the internet'", () => {
    const r = validateTaskCapabilities("scout", "search the internet for community solutions");
    expect(r.ok).toBe(false);
    expect(r.warning).toMatch(/web_search/);
  });

  it("warns coder when task says 'google the error'", () => {
    const r = validateTaskCapabilities("coder", "google the error message and find a fix");
    expect(r.ok).toBe(false);
    expect(r.warning).toMatch(/web_search/);
  });

  it("warns coder when task says 'google for docs'", () => {
    const r = validateTaskCapabilities("coder", "google for documentation about this library");
    expect(r.ok).toBe(false);
    expect(r.warning).toMatch(/web_search/);
  });

  it("warns reviewer when task says 'look it up online'", () => {
    const r = validateTaskCapabilities("reviewer", "look it up online and compare");
    expect(r.ok).toBe(false);
    expect(r.warning).toMatch(/web_search/);
  });

  it("warns writer when task says 'search the web'", () => {
    const r = validateTaskCapabilities("writer", "search the web for style guides");
    expect(r.ok).toBe(false);
    expect(r.warning).toMatch(/web_search/);
  });

  it("does NOT warn researcher for web tasks (has web_search)", () => {
    const r = validateTaskCapabilities("researcher", "search the web for documentation");
    expect(r.ok).toBe(true);
  });
});

describe("fetch_content true positives (must warn)", () => {
  it("warns scout when task says 'fetch the URL'", () => {
    const r = validateTaskCapabilities("scout", "fetch the URL https://example.com/api");
    expect(r.ok).toBe(false);
    expect(r.warning).toMatch(/fetch_content/);
  });

  it("warns scout when task says 'scrape the website'", () => {
    const r = validateTaskCapabilities("scout", "scrape the website for product data");
    expect(r.ok).toBe(false);
    expect(r.warning).toMatch(/fetch_content/);
  });

  it("warns coder when task says 'download from the webpage'", () => {
    const r = validateTaskCapabilities("coder", "download from the webpage and save locally");
    expect(r.ok).toBe(false);
    expect(r.warning).toMatch(/fetch_content/);
  });

  it("warns reviewer when task says 'fetch the http response'", () => {
    const r = validateTaskCapabilities("reviewer", "fetch the http response and check status");
    expect(r.ok).toBe(false);
    expect(r.warning).toMatch(/fetch_content/);
  });

  it("warns scout when task says 'fetch content from https URL'", () => {
    const r = validateTaskCapabilities("scout", "fetch content from https://docs.example.com");
    expect(r.ok).toBe(false);
    expect(r.warning).toMatch(/fetch_content/);
  });

  it("warns coder when task says 'curl the URL and parse'", () => {
    const r = validateTaskCapabilities("coder", "curl the URL and parse the JSON response");
    expect(r.ok).toBe(false);
    expect(r.warning).toMatch(/fetch_content/);
  });

  it("does NOT warn researcher for fetch tasks (has fetch_content)", () => {
    const r = validateTaskCapabilities("researcher", "fetch the URL https://example.com");
    expect(r.ok).toBe(true);
  });
});
