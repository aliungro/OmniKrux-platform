import type { CliLogin } from "../../api/types";
import { CLOUD_PROVIDERS } from "./cloudProviders";
import s from "./CloudSettings.module.css";

export function loginWords(login: CliLogin): string {
  const { cli } = CLOUD_PROVIDERS[login.provider];
  if (login.note) return login.note;
  if (login.state === "found") return `${cli} login found at ${login.path}`;
  if (login.state === "unreadable") return `The ${cli} login at ${login.path} couldn't be read.`;
  return `No ${cli} login at ${login.path}`;
}

export function LoginsSection({ logins }: { logins: CliLogin[] }) {
  if (!logins.length) return null;
  return <ul className={s.logins} aria-label="CLI logins">
    {logins.map(login => (
      <li key={login.provider} data-state={login.state}>
        <span className={s.loginDot} aria-hidden="true" />
        {loginWords(login)}
      </li>
    ))}
  </ul>;
}
