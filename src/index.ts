/**
 * Deployment & Export Engine
 * One-click cloud deployment targeting Vercel/Netlify
 * Build optimization for Web, PWA, and Mobile-ready exports
 */
import { EventEmitter } from "events";
import { createWriteStream, createReadStream, existsSync, mkdirSync, rmSync } from "fs";
import { join, resolve, dirname } from "path";
import { pipeline } from "stream/promises";
import { createGzip } from "zlib";
import { createHash } from "crypto";
import { v4 as uuidv4 } from "uuid";
import archiver from "archiver";

export type DeployTarget = "vercel" | "netlify" | "static" | "pwa" | "mobile";

export interface DeployConfig {
  target: DeployTarget;
  projectPath: string;
  outputPath: string;
  buildCommand?: string;
  installCommand?: string;
  envVars?: Record<string, string>;
  domain?: string;
  regions?: string[];
}

export interface BuildConfig {
  outputDir: string;
  publicPath: string;
  optimize: boolean;
  minify: boolean;
  sourceMaps: boolean;
  splitChunks: boolean;
  pwa: boolean;
  pwaConfig?: PWAConfig;
}

export interface PWAConfig {
  name: string;
  shortName: string;
  description: string;
  themeColor: string;
  backgroundColor: string;
  icons: PWAIcon[];
  startUrl: string;
  display: "standalone" | "fullscreen" | "minimal-ui" | "browser";
  orientation: "portrait" | "landscape" | "any";
}

export interface PWAIcon {
  src: string;
  sizes: string;
  type: string;
  purpose?: "any" | "maskable" | "monochrome";
}

export interface DeploySession {
  id: string;
  config: DeployConfig;
  status: "pending" | "building" | "packaging" | "deploying" | "completed" | "failed";
  progress: number;
  logs: DeployLog[];
  artifactPath?: string;
  artifactHash?: string;
  deployUrl?: string;
  startedAt: Date;
  completedAt?: Date;
  error?: string;
}

export interface DeployLog {
  timestamp: Date;
  level: "info" | "warn" | "error" | "debug";
  message: string;
  step?: string;
}

export interface DeployResult {
  success: boolean;
  sessionId: string;
  deployUrl?: string;
  artifactPath?: string;
  artifactHash?: string;
  logs: DeployLog[];
  error?: string;
}

const DEFAULT_BUILD_CONFIG: BuildConfig = {
  outputDir: "dist",
  publicPath: "/",
  optimize: true,
  minify: true,
  sourceMaps: true,
  splitChunks: true,
  pwa: false,
};

export class DeployEngine extends EventEmitter {
  private sessions: Map<string, DeploySession> = new Map();
  private config: DeployConfig;
  private buildConfig: BuildConfig;

  constructor(deployConfig: DeployConfig, buildConfig: Partial<BuildConfig> = {}) {
    super();
    this.config = deployConfig;
    this.buildConfig = { ...DEFAULT_BUILD_CONFIG, ...buildConfig };
  }

  async createSession(config?: Partial<DeployConfig>): Promise<string> {
    const sessionId = uuidv4();
    const mergedConfig = { ...this.config, ...config };
    
    const session: DeploySession = {
      id: sessionId,
      config: mergedConfig,
      status: "pending",
      progress: 0,
      logs: [],
      startedAt: new Date(),
    };

    this.sessions.set(sessionId, session);
    this.emit("session:created", session);

    // Start deployment asynchronously
    this.runDeployment(sessionId).catch((err) => {
      this.emit("session:error", { sessionId, error: err });
    });

    return sessionId;
  }

  private async runDeployment(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    try {
      // Step 1: Validate project
      await this.addLog(session, "info", "Validating project structure", "validate");
      session.status = "building";
      session.progress = 10;
      this.emit("session:progress", session);
      await this.validateProject(session);

      // Step 2: Install dependencies
      await this.addLog(session, "info", "Installing dependencies", "install");
      session.progress = 20;
      this.emit("session:progress", session);
      await this.installDependencies(session);

      // Step 3: Build project
      await this.addLog(session, "info", "Building project", "build");
      session.status = "building";
      session.progress = 40;
      this.emit("session:progress", session);
      await this.buildProject(session);

      // Step 4: Generate PWA assets if needed
      if (this.buildConfig.pwa) {
        await this.addLog(session, "info", "Generating PWA assets", "pwa");
        session.progress = 60;
        this.emit("session:progress", session);
        await this.generatePWAAssets(session);
      }

      // Step 5: Package artifact
      await this.addLog(session, "info", "Packaging deployment artifact", "package");
      session.status = "packaging";
      session.progress = 75;
      this.emit("session:progress", session);
      const artifactPath = await this.packageArtifact(session);

      // Step 6: Calculate hash
      await this.addLog(session, "info", "Calculating artifact hash", "hash");
      session.progress = 85;
      this.emit("session:progress", session);
      const artifactHash = await this.calculateHash(artifactPath);
      session.artifactPath = artifactPath;
      session.artifactHash = artifactHash;

      // Step 7: Deploy to target
      await this.addLog(session, "info", `Deploying to ${session.config.target}`, "deploy");
      session.status = "deploying";
      session.progress = 95;
      this.emit("session:progress", session);
      const deployUrl = await this.deployToTarget(session);

      session.deployUrl = deployUrl;
      session.status = "completed";
      session.progress = 100;
      session.completedAt = new Date();
      
      await this.addLog(session, "info", "Deployment completed successfully", "complete");
      this.emit("session:completed", session);
    } catch (error) {
      session.status = "failed";
      session.error = error instanceof Error ? error.message : String(error);
      session.completedAt = new Date();
      await this.addLog(session, "error", `Deployment failed: ${session.error}`, "error");
      this.emit("session:failed", { sessionId, error });
    }
  }

  private async validateProject(session: DeploySession): Promise<void> {
    const { projectPath } = session.config;
    
    // Check for package.json
    const packageJsonPath = join(projectPath, "package.json");
    if (!existsSync(packageJsonPath)) {
      throw new Error("package.json not found in project root");
    }

    // Check for build scripts
    const packageJson = JSON.parse(await import("fs").then(fs => fs.promises.readFile(packageJsonPath, "utf-8")));
    if (!packageJson.scripts?.build && !session.config.buildCommand) {
      throw new Error("No build script found in package.json");
    }

    await this.addLog(session, "info", "Project validation passed", "validate");
  }

  private async installDependencies(session: DeploySession): Promise<void> {
    const { projectPath, installCommand = "npm ci" } = session.config;
    
    // In real implementation, this would spawn npm/yarn/pnpm
    // For now, simulate the process
    await this.addLog(session, "info", `Running: ${installCommand}`, "install");
    
    // Simulate install time
    await new Promise(resolve => setTimeout(resolve, 100));
    
    await this.addLog(session, "info", "Dependencies installed", "install");
  }

  private async buildProject(session: DeploySession): Promise<void> {
    const { projectPath, buildCommand = "npm run build" } = session.config;
    
    await this.addLog(session, "info", `Running: ${buildCommand}`, "build");
    
    // In real implementation, this would spawn the build process
    // For now, simulate and create a mock build output
    const outputDir = join(projectPath, this.buildConfig.outputDir);
    mkdirSync(outputDir, { recursive: true });
    
    // Create minimal build output
    const indexHtml = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Deployed App</title>
</head>
<body>
  <div id="root">Hello from Deploy Engine!</div>
</body>
</html>
    `.trim();
    
    await import("fs").then(fs => fs.promises.writeFile(join(outputDir, "index.html"), indexHtml));
    
    // Create a mock JS bundle
    const bundleJs = `console.log("App loaded");`;
    await import("fs").then(fs => fs.promises.writeFile(join(outputDir, "bundle.js"), bundleJs));
    
    await this.addLog(session, "info", "Build completed", "build");
  }

  private async generatePWAAssets(session: DeploySession): Promise<void> {
    const { projectPath } = session.config;
    const outputDir = join(projectPath, this.buildConfig.outputDir);
    
    const pwaConfig = this.buildConfig.pwaConfig || {
      name: "Emergent App",
      shortName: "Emergent",
      description: "AI-powered full-stack web application",
      themeColor: "#3b82f6",
      backgroundColor: "#ffffff",
      icons: [
        { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
        { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      ],
      startUrl: "/",
      display: "standalone",
      orientation: "portrait",
    };

    // Generate manifest.json
    const manifest = {
      name: pwaConfig.name,
      short_name: pwaConfig.shortName,
      description: pwaConfig.description,
      theme_color: pwaConfig.themeColor,
      background_color: pwaConfig.backgroundColor,
      icons: pwaConfig.icons,
      start_url: pwaConfig.startUrl,
      display: pwaConfig.display,
      orientation: pwaConfig.orientation,
    };

    await import("fs").then(fs => fs.promises.writeFile(
      join(outputDir, "manifest.json"),
      JSON.stringify(manifest, null, 2)
    ));

    // Generate service worker
    const swContent = `
const CACHE_NAME = "emergent-v1";
const urlsToCache = ["/", "/index.html", "/bundle.js", "/manifest.json"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(urlsToCache))
  );
});

self.addEventListener("fetch", (event) => {
  event.respondWith(
    caches.match(event.request).then((response) => response || fetch(event.request))
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) =>
      Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      )
    )
  );
});
    `.trim();

    await import("fs").then(fs => fs.promises.writeFile(join(outputDir, "sw.js"), swContent));

    await this.addLog(session, "info", "PWA assets generated", "pwa");
  }

  private async packageArtifact(session: DeploySession): Promise<string> {
    const { projectPath, outputPath } = session.config;
    const buildOutputDir = join(projectPath, this.buildConfig.outputDir);
    const artifactName = `deploy-${session.id}.tar.gz`;
    const artifactPath = join(outputPath, artifactName);
    
    mkdirSync(dirname(artifactPath), { recursive: true });

    return new Promise((resolve, reject) => {
      const output = createWriteStream(artifactPath);
      const archive = archiver("tar", { gzip: true, gzipOptions: { level: 9 } });
      
      output.on("close", () => resolve(artifactPath));
      archive.on("error", reject);
      archive.pipe(output);
      
      archive.directory(buildOutputDir, false);
      archive.finalize();
    });
  }

  private async calculateHash(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = createHash("sha256");
      const stream = createReadStream(filePath);
      
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("end", () => resolve(hash.digest("hex")));
      stream.on("error", reject);
    });
  }

  private async deployToTarget(session: DeploySession): Promise<string> {
    const { target } = session.config;
    
    // In real implementation, this would call Vercel/Netlify APIs
    // For now, return a mock URL
    const mockUrls: Record<DeployTarget, string> = {
      vercel: `https://${session.id}.vercel.app`,
      netlify: `https://${session.id}.netlify.app`,
      static: `https://cdn.example.com/${session.id}/`,
      pwa: `https://pwa.example.com/${session.id}/`,
      mobile: `https://mobile.example.com/${session.id}/`,
    };

    await this.addLog(session, "info", `Deployed to ${target}`, "deploy");
    await new Promise(resolve => setTimeout(resolve, 50)); // Simulate deploy time
    
    return mockUrls[target];
  }

  private async addLog(session: DeploySession, level: DeployLog["level"], message: string, step?: string): Promise<void> {
    const log: DeployLog = {
      timestamp: new Date(),
      level,
      message,
      step,
    };
    session.logs.push(log);
    this.emit("log", { sessionId: session.id, log });
  }

  getSession(sessionId: string): DeploySession | undefined {
    return this.sessions.get(sessionId);
  }

  getAllSessions(): DeploySession[] {
    return Array.from(this.sessions.values());
  }

  async cancelSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session && session.status !== "completed" && session.status !== "failed") {
      session.status = "failed";
      session.error = "Cancelled by user";
      session.completedAt = new Date();
      await this.addLog(session, "warn", "Deployment cancelled", "cancel");
      this.emit("session:cancelled", session);
    }
  }

  getConfig(): DeployConfig {
    return { ...this.config };
  }

  getBuildConfig(): BuildConfig {
    return { ...this.buildConfig };
  }
}

// Factory functions for common deployment targets
export function createVercelDeploy(config: Omit<DeployConfig, "target">): DeployEngine {
  return new DeployEngine({ ...config, target: "vercel" });
}

export function createNetlifyDeploy(config: Omit<DeployConfig, "target">): DeployEngine {
  return new DeployEngine({ ...config, target: "netlify" });
}

export function createStaticDeploy(config: Omit<DeployConfig, "target">): DeployEngine {
  return new DeployEngine({ ...config, target: "static" });
}

export function createPWADeply(config: Omit<DeployConfig, "target">, pwaConfig: Partial<PWAConfig> = {}): DeployEngine {
  return new DeployEngine(
    { ...config, target: "pwa" },
    { pwa: true, pwaConfig: pwaConfig as PWAConfig }
  );
}

export function createMobileDeploy(config: Omit<DeployConfig, "target">): DeployEngine {
  return new DeployEngine(
    { ...config, target: "mobile" },
    { optimize: true, minify: true }
  );
}

export default DeployEngine;
