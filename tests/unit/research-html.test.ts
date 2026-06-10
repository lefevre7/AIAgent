import { describe, expect, test } from "vitest";

import { decodeHtmlEntities, extractHtmlTitle, htmlToMarkdown } from "@/core";

describe("HTML to markdown conversion", () => {
  test("extracts a readable markdown view from HTML content", () => {
    const html = `
      <html>
        <head>
          <title>Copilot Docs</title>
          <style>.hidden { display: none; }</style>
        </head>
        <body>
          <main>
            <h1>Copilot Docs</h1>
            <p>Use <strong>web fetch</strong> for exact URLs.</p>
            <ul>
              <li>Find sources</li>
              <li>Read details</li>
            </ul>
            <p>Visit <a href="https://example.com/docs">the docs</a>.</p>
            <pre><code>npm run test</code></pre>
            <script>console.log("ignore")</script>
          </main>
        </body>
      </html>
    `;

    const markdown = htmlToMarkdown(html);

    expect(extractHtmlTitle(html)).toBe("Copilot Docs");
    expect(markdown).toContain("# Copilot Docs");
    expect(markdown).toContain("Use **web fetch** for exact URLs.");
    expect(markdown).toContain("- Find sources");
    expect(markdown).toContain("[the docs](https://example.com/docs)");
    expect(markdown).toContain("```");
    expect(markdown).not.toContain("console.log");
  });

  test("decodes common HTML entities", () => {
    expect(decodeHtmlEntities("Tom &amp; Jerry &lt;3 &#x1F600;")).toBe("Tom & Jerry <3 😀");
  });
});
