import { describeProxy, type ProxyConfig } from "../profile/schema";
import { message } from "./i18n";

/** Localize authored UI text without translating user-supplied endpoint values. */
export function localizedProxySummary(proxy: ProxyConfig): string {
  if (proxy.type === "direct") return message("browserRouting");
  const endpoint = describeProxy({ ...proxy, authenticationRequired: false });
  return endpoint + (proxy.authenticationRequired ? message("proxyAuthenticationSuffix") : "");
}
