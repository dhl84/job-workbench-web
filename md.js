/* A small markdown reader for the notes. The page loads no libraries, because the
   sign-in session lives in browser storage where any script on the page could read
   it. Every character is escaped before a tag is added, and a link opens only when it
   starts with http:// or https://, so text copied from a job advert cannot run.
   ponytail: no nested lists and no images. Add them when a note needs them.
   Check it with:  node web/md.js */
(function (root) {
  "use strict";

  function esc(s) {
    return s.replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function inline(s) {
    return esc(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\w)/g, "$1<em>$2</em>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
               '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");   // a relative link has no target here
  }

  function cells(line) {
    return line.trim().replace(/^\||\|$/g, "").split("|").map(function (c) { return inline(c.trim()); });
  }

  function render(text) {
    var lines = String(text || "").replace(/\r/g, "").split("\n");
    var out = [], para = [], list = null, i = 0;
    function flush() {
      if (para.length) { out.push("<p>" + para.map(inline).join(" ") + "</p>"); para = []; }
      if (list) { out.push("</" + list + ">"); list = null; }
    }
    while (i < lines.length) {
      var line = lines[i], m;
      if (/^\s*<!--.*-->\s*$/.test(line)) { i++; continue; }          // tracker markers
      if (/^```/.test(line)) {
        flush();
        var code = [];
        for (i++; i < lines.length && !/^```/.test(lines[i]); i++) code.push(esc(lines[i]));
        out.push("<pre><code>" + code.join("\n") + "</code></pre>");
        i++; continue;
      }
      if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
        flush(); out.push("<h" + m[1].length + ">" + inline(m[2]) + "</h" + m[1].length + ">");
        i++; continue;
      }
      if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) { flush(); out.push("<hr>"); i++; continue; }
      if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || "")) {
        flush();
        var table = ["<table><thead><tr><th>" + cells(line).join("</th><th>") + "</th></tr></thead><tbody>"];
        for (i += 2; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i++) {
          table.push("<tr><td>" + cells(lines[i]).join("</td><td>") + "</td></tr>");
        }
        out.push(table.join("") + "</tbody></table>");
        continue;
      }
      if ((m = /^\s*>\s?(.*)$/.exec(line))) {
        flush(); out.push("<blockquote>" + inline(m[1]) + "</blockquote>"); i++; continue;
      }
      if ((m = /^\s*([-*]|\d+\.)\s+(.*)$/.exec(line))) {
        var kind = /\d/.test(m[1]) ? "ol" : "ul";
        if (para.length) { out.push("<p>" + para.map(inline).join(" ") + "</p>"); para = []; }
        if (list !== kind) { if (list) out.push("</" + list + ">"); out.push("<" + kind + ">"); list = kind; }
        out.push("<li>" + inline(m[2]) + "</li>");
        i++; continue;
      }
      if (!line.trim()) { flush(); i++; continue; }
      if (list) { out.push("</" + list + ">"); list = null; }
      para.push(line.trim());
      i++;
    }
    flush();
    return out.join("\n");
  }

  root.renderMarkdown = render;

  if (typeof module !== "undefined" && require.main === module) {
    var assert = require("assert");
    var html = render([
      "# Status <script>alert(1)</script>",
      "<!-- tracker:start -->",
      "- **Status**: Interviewing",
      "- Link: [advert](https://jobs.example/1) and [bad](javascript:alert(1))",
      "",
      "| Requirement | Match |",
      "|---|---|",
      "| Close | STRONG |",
      "",
      'Text with "quotes" and <b>tags</b>.'
    ].join("\n"));
    assert(html.indexOf("<script>") < 0, "a script tag must come out escaped");
    assert(html.indexOf("&lt;script&gt;") >= 0, "the escaped script must still show as text");
    assert(html.indexOf("tracker:start") < 0, "the tracker marker must not show");
    assert(html.indexOf("<strong>Status</strong>") >= 0, "bold must render");
    assert(html.indexOf('href="https://jobs.example/1"') >= 0, "an https link must open");
    assert(html.indexOf("javascript:") < 0, "a javascript link must not survive");
    assert(html.indexOf("<td>STRONG</td>") >= 0, "a table row must render");
    assert(html.indexOf("&lt;b&gt;") >= 0 && html.indexOf("&quot;") >= 0, "quotes and tags stay text");
    assert(render("") === "", "an empty note gives nothing");
    console.log("md.js self-test passed");
  }
})(typeof module !== "undefined" ? module.exports : window);
