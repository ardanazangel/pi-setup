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

function notify() {
	run("afplay", ["/System/Library/Sounds/Submarine.aiff"]);
	run("osascript", [
		"-e",
		'display notification "Turno completado" with title "pi"',
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
		if (elapsed >= NOTIFY_MIN_SECONDS) notify();
	});

	pi.on("session_shutdown", () => {
		turnStart = null;
	});
}
