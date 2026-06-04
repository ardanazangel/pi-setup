import { spawn, type ChildProcess } from "node:child_process";
import process from "node:process";

let child: ChildProcess | null = null;
let activeTurns = 0;

function start() {
	if (child) return;

	// Parent-bound: si pi muere inesperadamente, el watcher mata caffeinate
	const script = `parent=$1; shift; "$@" & c=$!; ( while kill -0 "$parent" 2>/dev/null; do sleep 5; done; kill "$c" 2>/dev/null ) & w=$!; trap "kill $c $w 2>/dev/null" TERM INT; wait "$c"; kill "$w" 2>/dev/null`;

	child = spawn("sh", ["-c", script, "pi-caffeinate", String(process.pid), "caffeinate", "-dimsu"], {
		detached: false,
		stdio: "ignore",
	});

	child.once("exit", () => { child = null; });
	child.once("error", () => { child = null; });
}

function stop() {
	if (!child) return;
	child.removeAllListeners();
	child.kill("SIGTERM");
	child = null;
}

export default function caffeinate(pi: any) {
	pi.on("agent_start", () => {
		activeTurns++;
		start();
	});

	pi.on("agent_end", () => {
		activeTurns = Math.max(0, activeTurns - 1);
		if (activeTurns === 0) stop();
	});

	pi.on("session_shutdown", () => {
		activeTurns = 0;
		stop();
	});
}
