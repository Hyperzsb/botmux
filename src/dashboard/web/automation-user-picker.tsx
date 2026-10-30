import React, { useEffect, useId, useState } from 'react';
import { useT } from './react-hooks.js';

interface UserOption { openId: string; name?: string; email?: string }

/** Shared by cron and webhook editors. Open IDs are always scoped to this bot. */
export function AutomationUserPicker(props: {
  botId: string; value: string; onChange(value: string): void;
}): React.JSX.Element {
  const tr = useT();
  const id = useId();
  const [users, setUsers] = useState<UserOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    setUsers([]);
    setError(false);
    if (!props.botId) return () => abort.abort();
    setLoading(true);
    fetch(`/api/automation-users?larkAppId=${encodeURIComponent(props.botId)}`, { signal: abort.signal })
      .then(async r => {
        if (!r.ok) throw new Error('users_unavailable');
        const body = await r.json();
        if (!Array.isArray(body.users)) throw new Error('users_unavailable');
        if (!abort.signal.aborted) setUsers(body.users);
      })
      .catch(() => { if (!abort.signal.aborted) setError(true); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [props.botId, reload]);
  return <div className="schedule-form-field cn-field">
    <label htmlFor={id}>{tr('automation.runAs')}</label>
    <select id={id} value={props.value} onChange={e => props.onChange(e.currentTarget.value)} disabled={loading || !props.botId}>
      <option value="">{tr('automation.defaultIdentity')}</option>
      {props.value && !users.some(u => u.openId === props.value)
        ? <option value={props.value}>{props.value}</option> : null}
      {users.map(u => <option key={u.openId} value={u.openId}>
        {u.name || u.openId}{u.email ? ` · ${u.email}` : ''}
      </option>)}
    </select>
    <small className="schedule-form-help">{tr('automation.runAsHelp')}</small>
    {loading ? <small role="status">{tr('automation.loading')}</small> : null}
    {!loading && !error && !users.length ? <small>{tr('automation.noUsers')}</small> : null}
    {error ? <small role="alert">{tr('automation.loadError')} <button type="button" onClick={() => setReload(n => n + 1)}>{tr('automation.retry')}</button></small> : null}
  </div>;
}
