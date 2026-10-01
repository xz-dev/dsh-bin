// Local, disposable trust root. Only manager's explicitly gated TEST_CA_FILE can trust it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { connect, createServer, type Socket } from "node:net";

export const TEST_CA_FILE = join(import.meta.dir, "fixtures/proxy-cert.pem");
export const TEST_TLS = { cert: readFileSync(TEST_CA_FILE), key: readFileSync(join(import.meta.dir, "fixtures/proxy-key.pem")) };
export type ConnectRecord = { line: string; authorization: string | null; firstBytes: Buffer };

// Raw TCP relay: HTTP ends at CONNECT; subsequent bytes go untouched to origin.
export async function connectProxy(options: { status?: number; stall?: boolean; upstreamHost?: string } = {}) {
	const requests: ConnectRecord[] = [], sockets = new Set<Socket>();
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		socket.on("error", () => socket.destroy());
		let head = Buffer.alloc(0), record: ConnectRecord | undefined;
		socket.on("data", (data) => {
			if (record) {
				if (record.firstBytes.length < 6) record.firstBytes = Buffer.concat([record.firstBytes, data]).subarray(0, 6);
				return;
			}
			head = Buffer.concat([head, data]);
			const end = head.indexOf("\r\n\r\n");
			if (end === -1) return;
			const lines = head.subarray(0, end).toString().split("\r\n");
			record = { line: lines[0]!, authorization: lines.slice(1).find((line) => /^proxy-authorization:/i.test(line))?.split(": ").slice(1).join(": ") ?? null, firstBytes: head.subarray(end + 4, end + 10) };
			requests.push(record);
			const status = options.status ?? 200;
			if (status < 200 || status >= 300) { socket.end(`HTTP/1.1 ${status} Proxy refused\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`); return; }
			if (options.stall) { socket.write(`HTTP/1.1 ${status} Connection established\r\n\r\n`); return; }
			const authority = /^CONNECT (\S+) HTTP\/1\.1$/.exec(record.line)?.[1];
			if (!authority) { socket.destroy(); return; }
			const target = new URL(`http://${authority}`);
			const upstream = connect({ host: options.upstreamHost ?? (target.hostname === "localhost" ? "127.0.0.1" : target.hostname), port: Number(target.port) });
			sockets.add(upstream);
			upstream.on("close", () => { sockets.delete(upstream); socket.destroy(); });
			upstream.on("error", () => { upstream.destroy(); socket.destroy(); });
			socket.on("close", () => upstream.destroy());
			upstream.on("connect", () => {
				socket.write(`HTTP/1.1 ${status} Connection established\r\n\r\n`);
				if (head.length > end + 4) upstream.write(head.subarray(end + 4));
				socket.pipe(upstream); upstream.pipe(socket);
			});
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("expected proxy TCP address");
	return {
		requests, url: `http://127.0.0.1:${address.port}`,
		async stop() { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); },
	};
}
