import { spawn } from "node:child_process";

const NOTIFY_MIN_SECONDS = 10;

let turnStart: number | null = null;

function run(cmd: string, args: string[]) {
	try {
		const child = spawn(cmd, args, { detached: false, stdio: "ignore" });
		child.on("error", () => {});
	} catch {
		// nunca tirar la sesión
	}
}

function formatElapsed(seconds: number) {
	if (seconds < 60) return `${Math.round(seconds)}s`;
	const minutes = Math.floor(seconds / 60);
	const rest = Math.round(seconds % 60);
	return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

function notify(elapsed: number) {
	run("osascript", [
		"-e",
		"use scripting additions",
		"-e",
		`display notification ${JSON.stringify(`Listo en ${formatElapsed(elapsed)}`)} with title "pi" subtitle "Turno completado" sound name "Purr"`,
	]);
}

export default function notifyExtension(pi: any) {
	pi.on("agent_start", () => {
		turnStart = Date.now();
	});

	pi.on("agent_end", () => {
		if (turnStart === null) return;
		const elapsed = (Date.now() - turnStart) / 1000;
		turnStart = null;
		if (elapsed >= NOTIFY_MIN_SECONDS) notify(elapsed);
	});

	pi.on("session_shutdown", () => {
		turnStart = null;
	});
}
