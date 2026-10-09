import { message, type MessageKey } from "./i18n";
/** Describes the draft's actual choices; never claims unsupported protocol guarantees. */
export function protectionKeys(
  type: string,
  dns: boolean,
  webrtc: string,
  automatic: boolean,
): MessageKey[] {
  return [
    type === "socks4" || type === "socks5" ? (dns ? "dnsOn" : "dnsOff") : "dnsProtocol",
    webrtc === "proxy_only" ? "webrtcOn" : "webrtcCustom",
    automatic ? "identityOn" : "identityCustom",
  ];
}
export function protectionSummary(
  type: string,
  dns: boolean,
  webrtc: string,
  automatic: boolean,
): string {
  return protectionKeys(type, dns, webrtc, automatic)
    .map((key) => message(key))
    .join(" · ");
}
