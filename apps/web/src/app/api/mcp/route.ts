import path from "node:path";
import { handleMcp } from "@/agent/mcp";

// Model Context Protocol endpoint for local clients (Streamable HTTP, JSON answers). See AGENT.md.
const WORKSPACE = path.resolve(process.env.AGENT_WORKSPACE ?? path.join(process.cwd(), "..", "..", "workspace"));

export async function POST(req: Request) {
	return handleMcp(req, WORKSPACE);
}

export async function GET(req: Request) {
	return handleMcp(req, WORKSPACE);
}

export async function DELETE(req: Request) {
	return handleMcp(req, WORKSPACE);
}
