#!/usr/bin/env python3
"""Fetch recent Gmail messages over IMAP and emit clean JSON for triage.

Read-only: opens the mailbox in readonly mode, never marks/moves/deletes.
The agent (pi) reads the JSON output and does the classify + summarize step.

Credentials come from env vars so secrets never enter the agent's context:
  GMAIL_USER          your full gmail address
  GMAIL_APP_PASSWORD  a Google "app password" (requires 2FA on the account)

Usage:
  GMAIL_USER=you@gmail.com GMAIL_APP_PASSWORD=xxxx python3 fetch.py [N]
  N = how many of the most recent messages to fetch (default 15)

ponytail: read-only triage feed. Ceiling = no OAuth (app password only),
plain-text bodies only, no attachments. Upgrade path: swap imaplib auth for
OAuth2 + add a send/draft step if you later want auto-reply.
"""
import email
import imaplib
import json
import os
import quopri
import re
import sys
from email.header import decode_header, make_header
from html.parser import HTMLParser

IMAP_HOST = "imap.gmail.com"
IMAP_PORT = 993
BODY_LIMIT = 2000  # chars; keep agent context small
ENV_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")


def load_dotenv() -> None:
    """Populate os.environ from a sibling .env file (KEY=value per line).
    Existing env vars win, so an exported value overrides the file."""
    try:
        with open(ENV_PATH, encoding="utf-8") as fh:
            lines = fh.readlines()
    except FileNotFoundError:
        return
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        key, val = key.strip(), val.strip().strip("'\"")
        if key and key not in os.environ:
            os.environ[key] = val


def decode_str(raw) -> str:
    if not raw:
        return ""
    try:
        return str(make_header(decode_header(raw)))
    except Exception:
        return str(raw)


class _HTMLStripper(HTMLParser):
    """Collect text nodes, skipping script/style."""
    def __init__(self):
        super().__init__()
        self.parts = []
        self.skip = False

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style", "title", "head"):
            self.skip = True

    def handle_endtag(self, tag):
        if tag in ("script", "style", "title", "head"):
            self.skip = False

    def handle_data(self, data):
        if not self.skip:
            self.parts.append(data)


def strip_html(s: str) -> str:
    p = _HTMLStripper()
    try:
        p.feed(s)
    except Exception:
        return s
    return "".join(p.parts)


def maybe_decode_qp(text: str) -> str:
    """Some senders ship quoted-printable but mislabel Content-Transfer-Encoding,
    so get_payload(decode=True) leaves literal =XX / =<EOL> soft breaks. The
    =<EOL> soft-break is the reliable signal; decode defensively when present."""
    if "=\n" in text or "=\r\n" in text:
        try:
            return quopri.decodestring(text.encode("utf-8", "replace")).decode(
                "utf-8", errors="replace")
        except Exception:
            return text
    return text


def clean_text(s: str) -> str:
    s = s.replace("\u200c", "").replace("\u200b", "").replace("\u00a0", " ")
    s = s.replace("\r\n", "\n").replace("\r", "\n")
    s = re.sub(r"[ \t]+", " ", s)
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s.strip()


def extract_body(msg) -> str:
    """Best-effort body: prefer text/plain, fall back to stripped HTML."""
    plain, html_body = "", ""
    for part in msg.walk():
        if part.get_content_maintype() == "multipart":
            continue
        disp = str(part.get("Content-Disposition") or "")
        if "attachment" in disp:
            continue
        payload = part.get_payload(decode=True)
        if not payload:
            continue
        charset = part.get_content_charset() or "utf-8"
        text = payload.decode(charset, errors="replace")
        ctype = part.get_content_type()
        if ctype == "text/plain" and not plain:
            plain = text
        elif ctype == "text/html" and not html_body:
            html_body = text
    raw = plain if plain.strip() else strip_html(html_body)
    return clean_text(maybe_decode_qp(raw))


def main() -> int:
    load_dotenv()
    user = os.environ.get("GMAIL_USER")
    pw = os.environ.get("GMAIL_APP_PASSWORD")
    if not user or not pw:
        print("error: set GMAIL_USER and GMAIL_APP_PASSWORD env vars", file=sys.stderr)
        return 2

    count = int(sys.argv[1]) if len(sys.argv) > 1 else 15

    conn = imaplib.IMAP4_SSL(IMAP_HOST, IMAP_PORT)
    try:
        conn.login(user, pw)
        conn.select("INBOX", readonly=True)
        typ, data = conn.search(None, "ALL")
        if typ != "OK":
            print("error: IMAP search failed", file=sys.stderr)
            return 1
        ids = data[0].split()
        recent = ids[-count:][::-1]  # newest first

        out = []
        for mid in recent:
            typ, msg_data = conn.fetch(mid, "(RFC822)")
            if typ != "OK" or not msg_data or not msg_data[0]:
                continue
            msg = email.message_from_bytes(msg_data[0][1])
            body = extract_body(msg).strip()
            out.append({
                "from": decode_str(msg.get("From")),
                "to": decode_str(msg.get("To")),
                "subject": decode_str(msg.get("Subject")),
                "date": decode_str(msg.get("Date")),
                "body": body[:BODY_LIMIT],
                "truncated": len(body) > BODY_LIMIT,
            })
        print(json.dumps(out, ensure_ascii=False, indent=2))
        return 0
    finally:
        try:
            conn.logout()
        except Exception:
            pass


if __name__ == "__main__":
    sys.exit(main())
