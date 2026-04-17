import { Channel, NewMessage } from './types.js';
import { formatLocalTime } from './timezone.js';

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatMessages(
  messages: NewMessage[],
  timezone: string = 'UTC',
): string {
  const lines = messages.map((m) => {
    const displayTime = formatLocalTime(m.timestamp, timezone);
    const trustAttr = m.trust_tier ? ` trust="${escapeXml(m.trust_tier)}"` : '';
    const replyAttr = m.reply_to_message_id
      ? ` reply_to="${escapeXml(m.reply_to_message_id)}"`
      : '';
    const replyTag = m.reply_to_message_content
      ? `\n  <quoted_message from="${escapeXml(m.reply_to_sender_name || '')}">${escapeXml(m.reply_to_message_content)}</quoted_message>`
      : '';
    if (replyTag) {
      return `<message id="${escapeXml(m.id)}" sender="${escapeXml(m.sender_name)}" time="${escapeXml(displayTime)}"${trustAttr}${replyAttr}>${replyTag}\n  ${escapeXml(m.content)}\n</message>`;
    }
    return `<message id="${escapeXml(m.id)}" sender="${escapeXml(m.sender_name)}" time="${escapeXml(displayTime)}"${trustAttr}${replyAttr}>${escapeXml(m.content)}</message>`;
  });
  return `<context timezone="${escapeXml(timezone)}" />\n<messages>\n${lines.join('\n')}\n</messages>`;
}

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

export function formatOutbound(rawText: string): string {
  const text = stripInternalTags(rawText);
  if (!text) return '';
  return text;
}

export function routeOutbound(
  channels: Channel[],
  jid: string,
  text: string,
): Promise<void> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  return channel.sendMessage(jid, text);
}

export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}
