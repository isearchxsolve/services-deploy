import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { DeployEngine } from "../src/index";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let testProjectPath: string;
let testOutputPath: string;

describe("DeployEngine", () => {
  let engine: DeployEngine;
  beforeAll(() => {
    testProjectPath = join(tmpdir(), "emergent-test-project-" + Date.now());
    testOutputPath = join(tmpdir(), "emergent-test-output-" + Date.now());
    mkdirSync(testProjectPath, { recursive: true });
    mkdirSync(testOutputPath, { recursive: true });
    writeFileSync(join(testProjectPath, "package.json"), JSON.stringify({ name: "test-app", version: "1.0.0", scripts: { build: "echo build complete" } }, null, 2));
  });
  afterAll(() => {
    if (existsSync(testProjectPath)) rmSync(testProjectPath, { recursive: true, force: true });
    if (existsSync(testOutputPath)) rmSync(testOutputPath, { recursive: true, force: true });
  });
  it("should create a session", async () => {
    const config = { target: "static", projectPath: testProjectPath, outputPath: testOutputPath };
    engine = new DeployEngine(config);
    const sessionId = await engine.createSession();
    expect(sessionId).toBeDefined();
    const session = engine.getSession(sessionId);
    expect(session).toBeDefined();
    expect(["pending", "building"]).toContain(session?.status);
  });
});

describe("Factory Functions", () => {
	 it("should create Vercel deploy engine", () => {
		 const engine = new DeployEngine({ target: "vercel", projectPath: testProjectPath, outputPath: testOutputPath });
		expect(engine.getConfig().target).toBe("vercel");
	});
});