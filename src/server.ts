import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type CallToolResult, type GetPromptResult, type ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";

export type HeadersLike = Record<string, string | string[] | undefined>;

export const getServer = (requestHeaders?: HeadersLike): McpServer => {
  const server = new McpServer(
    {
      name: "mcp-server-template",
      version: "0.0.1",
    },
    { capabilities: {} },
  );

  // Register a simple prompt
  server.prompt(
    "greeting-template",
    "A simple greeting prompt template",
    {
      name: z.string().describe("Name to include in greeting"),
    },
    async ({ name }): Promise<GetPromptResult> => {
      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Please greet ${name} in a friendly manner.`,
            },
          },
        ],
      };
    },
  );

  server.tool(
    "greet",
    "A simple greeting tool",
    {
      name: z.string().describe("Name to greet"),
    },
    async ({ name }): Promise<CallToolResult> => {
      return {
        content: [
          {
            type: "text",
            text: `Hello, ${name}!`,
          },
        ],
      };
    },
  );

  server.resource(
    "greeting-resource",
    "https://example.com/greetings/default",
    { mimeType: "text/plain" },
    async (): Promise<ReadResourceResult> => {
      return {
        contents: [
          {
            uri: "https://example.com/greetings/default",
            text: "Hello, world!",
          },
        ],
      };
    },
  );

  // Property Inquiry Email Template (simple static resource returning JSON template)
  server.resource(
    "property-inquiry-email-template",
    "email-template://property-inquiry",
    { mimeType: "application/json" },
    async (): Promise<ReadResourceResult> => {
      const subject = "Interested by your property!";
      const text = [
        "Hello,",
        "",
        "We came across your listing for your property and we're really interested!",
        "",
        "Here is the link to the property: {{property_link}}",
        "",
        "Would it be possible to schedule a visit?",
        "",
        "Looking forward to hearing back from you!",
        "",
        "Thanks,",
        "[SENDER_NAME]",
      ].join("\n");

      const payload = JSON.stringify(
        {
          subject,
          text,
        },
        null,
        2,
      );

      return {
        contents: [
          {
            uri: "email-template://property-inquiry",
            text: payload,
          },
        ],
      };
    },
  );

  // Send Email via Resend API (pass-through auth via request headers)
  server.tool(
    "send_email",
    "Send emails via Resend API. Provide html_content and/or text_content.",
    {
      to_emails: z.array(z.string().email()).min(1).max(50).describe("List of recipient email addresses (max 50)"),
      subject: z.string().min(1).describe("Email subject line"),
      sender_email: z.string().email().describe("Sender email address, verified in Resend"),
      html_content: z.string().optional().describe("HTML content of the email"),
      text_content: z.string().optional().describe("Plain text version of the email"),
      cc_emails: z.array(z.string().email()).optional().describe("CC recipients"),
      bcc_emails: z.array(z.string().email()).optional().describe("BCC recipients"),
      reply_to: z.union([z.string().email(), z.array(z.string().email())]).optional().describe("Reply-to email address(es)"),
      scheduled_at: z.string().optional().describe("Schedule email for later (natural language or ISO 8601)"),
      attachments: z
        .array(
          z.object({
            content: z.string().describe("Base64-encoded content"),
            filename: z.string(),
            path: z.string().optional(),
            content_type: z.string().optional(),
            content_id: z.string().optional(),
          }),
        )
        .optional()
        .describe("Attachments (max 40MB total)"),
      tags: z
        .array(
          z.object({
            name: z.string(),
            value: z.string(),
          }),
        )
        .optional()
        .describe("Custom tags as key/value pairs"),
    },
    async ({
      to_emails,
      subject,
      sender_email,
      html_content,
      text_content,
      cc_emails,
      bcc_emails,
      reply_to,
      scheduled_at,
      attachments,
      tags,
    }): Promise<CallToolResult> => {
      // Extract API key from request headers (pass-through from client)
      const headerKeyCandidates = ["x-resend-api-key", "x-api-key", "authorization"] as const;
      let apiKey: string | undefined;
      for (const key of headerKeyCandidates) {
        const raw = requestHeaders?.[key];
        if (!raw) continue;
        const value = Array.isArray(raw) ? raw[0] : raw;
        if (key === "authorization") {
          const match = /^Bearer\s+(.+)$/i.exec(value);
          if (match) {
            apiKey = match[1];
            break;
          }
        } else {
          apiKey = value;
          break;
        }
      }

      if (!apiKey) {
        return {
          content: [
            {
              type: "text",
              text: "Missing API key. Provide 'X-Resend-API-Key' or 'X-API-Key' header (or Authorization: Bearer <key>).",
            },
          ],
          isError: true,
        };
      }

      if (!html_content && !text_content) {
        return {
          content: [
            { type: "text", text: "At least one of html_content or text_content must be provided." },
          ],
          isError: true,
        };
      }

      const url = "https://api.resend.com/emails";
      const payload: Record<string, unknown> = {
        from: sender_email,
        to: to_emails,
        subject,
      };
      if (html_content) payload.html = html_content;
      if (text_content) payload.text = text_content;
      if (cc_emails && cc_emails.length) payload.cc = cc_emails;
      if (bcc_emails && bcc_emails.length) payload.bcc = bcc_emails;
      if (reply_to) payload.reply_to = reply_to;
      if (scheduled_at) payload.scheduled_at = scheduled_at;
      if (attachments && attachments.length) payload.attachments = attachments;
      if (tags && tags.length) payload.tags = tags;

      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(payload),
        });

        const data = (await response.json()) as { id?: string; message?: string };
        if (!response.ok) {
          const message = data?.message || `HTTP ${response.status}`;
          return {
            content: [{ type: "text", text: `Email send failed: ${message}` }],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: "text",
              text: `Email sent successfully. id: ${data.id ?? "unknown"}`,
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Email send failed: ${message}` }],
          isError: true,
        };
      }
    },
  );

  return server;
};
