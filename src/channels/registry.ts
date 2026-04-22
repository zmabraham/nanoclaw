import {
  Channel,
  OnMessageReceived,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

export interface ChannelOpts {
  /** Preferred: called with (chatJid, message, mediaRefs). Channels that
   *  participate in the media-ingestion pipeline should use this. */
  onMessageReceived?: OnMessageReceived;
  /** Legacy: channels that don't handle media-ingestion still call this.
   *  Kept as an alias type — signature is identical because OnInboundMessage
   *  is a re-export of OnMessageReceived during the migration window. */
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export type ChannelFactory = (opts: ChannelOpts) => Channel | null;

const registry = new Map<string, ChannelFactory>();

export function registerChannel(name: string, factory: ChannelFactory): void {
  registry.set(name, factory);
}

export function getChannelFactory(name: string): ChannelFactory | undefined {
  return registry.get(name);
}

export function getRegisteredChannelNames(): string[] {
  return [...registry.keys()];
}
