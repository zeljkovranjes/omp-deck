import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { buildSlashCommandsRouter } from "./routes-slash-commands.ts";

let workdir: string | null = null;

afterEach(async () => {
	if (workdir) {
		await fs.rm(workdir, { recursive: true, force: true });
		workdir = null;
	}
});

describe("project slash-command discovery", () => {
	test("matches the OMP SDK native project path", async () => {
		workdir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-deck-commands-"));
		const canonical = path.join(workdir, ".omp", "commands");
		const misplaced = path.join(workdir, ".omp", "agent", "commands");
		await fs.mkdir(canonical, { recursive: true });
		await fs.mkdir(misplaced, { recursive: true });
		await fs.writeFile(
			path.join(canonical, "motion-task.md"),
			"---\ndescription: Claim one task\n---\nBody\n",
		);
		await fs.writeFile(
			path.join(misplaced, "wrong-path.md"),
			"---\ndescription: Must not be discovered\n---\nBody\n",
		);

		const app = buildSlashCommandsRouter();
		const response = await app.request(
			`/slash-commands?cwd=${encodeURIComponent(workdir)}`,
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			commands: Array<{ name: string; scope: string; description?: string }>;
		};
		const project = body.commands.filter((command) => command.scope === "project");

		expect(project).toEqual([
			{
				name: "motion-task",
				scope: "project",
				description: "Claim one task",
			},
		]);
	});
});
