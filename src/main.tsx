import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Download, LogOut, Search, MessageCircle, CheckCircle2, Clock3, ShieldCheck, RefreshCw } from 'lucide-react';
import { supabase } from './lib/supabase';
import './styles.css';

type Row = {
  participantId: string;
  registrationId: string;
  registrationCode: string;
  eventId: string;
  eventName: string;
  registrationType: string;
  name: string;
  email: string;
  phone: string;
  college: string;
  department: string;
  year: string;
  status: 'pending' | 'added';
  checkedIn: boolean;
  team: string;
  teamMemberId?: string;
};

type Session = { master: boolean; email: string; eventId?: string; eventName?: string; role: string };

const csv = (rows: Row[]) => {
  const head = ['Name', 'Team', 'Event', 'Email', 'Phone', 'College', 'Department', 'Year', 'WhatsApp Status', 'Check-in Status', 'Registration ID'];
  const esc = (v: unknown) => `"${String(v ?? '').replaceAll('"', '""')}"`;
  return [head, ...rows.map(r => [r.name, r.team, r.eventName, r.email, r.phone, r.college, r.department, r.year, r.status, r.checkedIn ? 'Checked in' : 'Not checked in', r.registrationCode])]
    .map(r => r.map(esc).join(','))
    .join('\n');
};

function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [events, setEvents] = useState<{ id: string; name: string }[]>([]);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<'all' | 'pending' | 'added'>('all');
  const [sort, setSort] = useState<keyof Row>('name');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');

  const loadData = async (active: Session) => {
    setLoading(true);
    setMessage('');
    try {
      let eventIds: string[] = [];
      if (active.master) {
        const { data, error } = await supabase.from('events').select('id,name').order('name');
        if (error) throw error;
        const eventList = (data ?? []) as { id: string; name: string }[];
        setEvents(eventList);
        eventIds = eventList.map(e => e.id);
      } else {
        if (!active.eventId) throw new Error('No event access is assigned to this account.');
        const { data, error } = await supabase.from('events').select('id,name').eq('id', active.eventId).single();
        if (error) throw error;
        const event = data as { id: string; name: string };
        setEvents([event]);
        eventIds = [event.id];
      }

      if (!eventIds.length) {
        setRows([]);
        return;
      }

      const { data: registrations, error: regError } = await supabase
        .from('registrations')
        .select('id,registration_id,event_id,registration_type,status,checked_in')
        .in('event_id', eventIds);
      if (regError) throw regError;

      const regs = (registrations ?? []) as any[];
      const registrationIds = regs.map(r => r.id);
      if (!registrationIds.length) {
        setRows([]);
        return;
      }

      const [{ data: participants, error: participantError }, { data: teams, error: teamError }] = await Promise.all([
        supabase.from('participants').select('id,registration_id,name,email,phone,college,department,year,whatsapp_added').in('registration_id', registrationIds),
        supabase.from('teams').select('id,registration_id,team_name').in('registration_id', registrationIds),
      ]);
      if (participantError) throw participantError;
      if (teamError) throw teamError;

      const teamList = (teams ?? []) as any[];
      const teamIds = teamList.map(t => t.id);
      const { data: teamMembers, error: memberError } = teamIds.length
        ? await supabase.from('team_members').select('id,team_id,email,whatsapp_added').in('team_id', teamIds)
        : { data: [], error: null };
      if (memberError) throw memberError;

      const eventMap = new Map((events.length ? events : (await supabase.from('events').select('id,name').in('id', eventIds))).data?.map((e: any) => [e.id, e.name]) ?? []);
      const regMap = new Map(regs.map(r => [r.id, r]));
      const teamMap = new Map(teamList.map(t => [t.registration_id, t]));
      const memberMap = new Map(((teamMembers ?? []) as any[]).map(m => [`${m.team_id}:${m.email?.toLowerCase()}`, m]));

      const nextRows: Row[] = ((participants ?? []) as any[]).map(p => {
        const reg = regMap.get(p.registration_id);
        const team = teamMap.get(p.registration_id);
        const member = team ? memberMap.get(`${team.id}:${p.email?.toLowerCase()}`) : undefined;
        return {
          participantId: p.id,
          registrationId: p.registration_id,
          registrationCode: reg?.registration_id ?? '',
          eventId: reg?.event_id ?? '',
          eventName: eventMap.get(reg?.event_id) ?? 'Unknown event',
          registrationType: reg?.registration_type ?? 'individual',
          name: p.name ?? '',
          email: p.email ?? '',
          phone: p.phone ?? '',
          college: p.college ?? '',
          department: p.department ?? '',
          year: p.year ?? '',
          status: (member?.whatsapp_added ?? p.whatsapp_added) ? 'added' : 'pending',
          checkedIn: Boolean(reg?.checked_in),
          team: team?.team_name ?? '—',
          teamMemberId: member?.id,
        };
      });
      setRows(nextRows);
    } catch (err: any) {
      console.error('Live participant load failed:', err);
      setMessage(err?.message || 'Could not load live registration data.');
    } finally {
      setLoading(false);
    }
  };

  const login = async () => {
    setLoading(true);
    setMessage('');
    try {
      const { data, error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (error) throw error;
      if (!data.user) throw new Error('Login failed.');

      const { data: profile, error: profileError } = await supabase.from('profiles').select('email,role').eq('id', data.user.id).single();
      if (profileError) throw profileError;

      const role = String(profile?.role ?? '').toLowerCase();
      if (role !== 'organizer' && role !== 'coordinator') {
        await supabase.auth.signOut();
        throw new Error('This account is not a coordinator account.');
      }

      if (role === 'organizer') {
        const active: Session = { master: true, email: data.user.email ?? email.trim(), role };
        setSession(active);
        await loadData(active);
      } else {
        const { data: access, error: accessError } = await supabase
          .from('coordinator_event_access')
          .select('event_id')
          .eq('user_id', data.user.id)
          .maybeSingle();
        if (accessError) throw accessError;
        if (!access?.event_id) throw new Error('No event has been assigned to this coordinator account.');
        const { data: event, error: eventError } = await supabase.from('events').select('id,name').eq('id', access.event_id).single();
        if (eventError) throw eventError;
        const active: Session = { master: false, email: data.user.email ?? email.trim(), role, eventId: event.id, eventName: event.name };
        setSession(active);
        await loadData(active);
      }
      setPassword('');
    } catch (err: any) {
      console.error('Coordinator login failed:', err);
      setMessage(err?.message || 'Invalid coordinator credentials.');
      await supabase.auth.signOut();
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data }) => {
      if (!data.session?.user) return;
      const { data: profile } = await supabase.from('profiles').select('email,role').eq('id', data.session.user.id).single();
      if (!profile) return;
      if (profile.role === 'organizer') {
        const active: Session = { master: true, email: data.session.user.email ?? '', role: profile.role };
        setSession(active);
        loadData(active);
      } else if (profile.role === 'coordinator') {
        const { data: access } = await supabase.from('coordinator_event_access').select('event_id').eq('user_id', data.session.user.id).maybeSingle();
        if (access?.event_id) {
          const { data: event } = await supabase.from('events').select('id,name').eq('id', access.event_id).single();
          if (event) {
            const active: Session = { master: false, email: data.session.user.email ?? '', role: profile.role, eventId: event.id, eventName: event.name };
            setSession(active);
            loadData(active);
          }
        }
      }
    });
  }, []);

  const logout = async () => {
    await supabase.auth.signOut();
    setSession(null);
    setRows([]);
    setEmail('');
    setPassword('');
    setMessage('');
  };

  const updateWhatsApp = async (row: Row) => {
    const next = row.status !== 'added';
    setMessage('');
    setRows(current => current.map(r => r.participantId === row.participantId ? { ...r, status: next ? 'added' : 'pending' } : r));
    const { error } = await supabase.from('participants').update({ whatsapp_added: next }).eq('id', row.participantId);
    if (error) {
      setRows(current => current.map(r => r.participantId === row.participantId ? { ...r, status: row.status } : r));
      setMessage(error.message || 'Could not update WhatsApp status.');
      return;
    }
    if (row.teamMemberId) {
      const { error: memberError } = await supabase.from('team_members').update({ whatsapp_added: next }).eq('id', row.teamMemberId);
      if (memberError) console.warn('Team member WhatsApp sync failed:', memberError);
    }
  };

  const visible = useMemo(() => rows
    .filter(r => status === 'all' || r.status === status)
    .filter(r => Object.values(r).join(' ').toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => String(a[sort]).localeCompare(String(b[sort]))), [rows, q, status, sort]);

  const exportCsv = () => {
    const blob = new Blob([csv(visible)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${session?.master ? 'itekron-all' : session?.eventName?.toLowerCase().replaceAll(' ', '-')}-participants.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!session) return <main className="login"><div className="glow"/><section className="login-card">
    <div className="brand">ITEKRON <span>2K26</span></div>
    <div className="eyebrow"><ShieldCheck size={14}/> COORDINATOR PORTAL</div>
    <h1>Event operations,<br/><em>made simple.</em></h1>
    <p>Sign in to view live participant registrations and manage WhatsApp group status.</p>
    <input placeholder="Coordinator email" type="email" value={email} onChange={e => setEmail(e.target.value)} onKeyDown={e => e.key === 'Enter' && login()}/>
    <input placeholder="Password" type="password" value={password} onChange={e => setPassword(e.target.value)} onKeyDown={e => e.key === 'Enter' && login()}/>
    {message && <div className="login-error">{message}</div>}
    <button onClick={login} disabled={loading}>{loading ? 'Signing in...' : 'Sign in'}</button>
    <small>Access is controlled by Supabase Auth and event-level permissions.</small>
  </section></main>;

  const added = rows.filter(r => r.status === 'added').length;
  const pending = rows.filter(r => r.status === 'pending').length;
  const checkedIn = rows.filter(r => r.checkedIn).length;

  return <main className="app">
    <header><div><div className="brand">ITEKRON <span>2K26</span></div><div className="sub">Coordinator Portal · Live Supabase</div></div><div className="head-right"><b>{session.master ? 'All Events' : session.eventName}</b><button className="icon-btn" onClick={logout}><LogOut size={18}/></button></div></header>
    <section className="hero"><div><div className="eyebrow"><ShieldCheck size={14}/> {session.master ? 'MASTER ACCESS' : 'EVENT ACCESS'}</div><h1>{session.master ? 'Coordinator overview' : `${session.eventName} participants`}</h1><p>Live registration data. WhatsApp status updates are saved directly to the database.</p></div><div className="hero-actions"><button className="export" onClick={() => loadData(session)} disabled={loading}><RefreshCw size={16}/> Refresh</button><button className="export" onClick={exportCsv}><Download size={16}/> Export CSV</button></div></section>
    {message && <div className="message">{message}</div>}
    <section className="stats"><div><strong>{rows.length}</strong><span>Total participants</span></div><div><strong>{added}</strong><span>WhatsApp added</span></div><div><strong>{pending}</strong><span>Pending</span></div><div><strong>{checkedIn}</strong><span>Checked in</span></div></section>
    <section className="toolbar"><div className="search"><Search size={17}/><input value={q} onChange={e => setQ(e.target.value)} placeholder="Search name, team, phone, college..."/></div><div className="filters">{(['all','pending','added'] as const).map(s => <button className={status === s ? 'active' : ''} onClick={() => setStatus(s)} key={s}>{s === 'all' ? 'All' : s === 'pending' ? 'Pending' : 'Added'}</button>)}</div></section>
    <div className="table-wrap"><table><thead><tr>{[['name','Name'],['team','Team'],['eventName','Event'],['college','College'],['status','WhatsApp']].map(([k,l]) => <th onClick={() => setSort(k as keyof Row)} key={k}>{l}</th>)}<th>Contact</th></tr></thead><tbody>{visible.map(r => <tr key={r.participantId}><td><b>{r.name}</b><small>{r.email}</small></td><td>{r.team}</td><td>{r.eventName}<small>{r.registrationType} · {r.registrationCode}</small></td><td>{r.college}<small>{r.department} · Year {r.year}</small></td><td><button className={`status ${r.status}`} onClick={() => updateWhatsApp(r)}>{r.status === 'added' ? <CheckCircle2 size={15}/> : <Clock3 size={15}/>} {r.status === 'added' ? 'Added' : 'Pending'}</button></td><td><a className="wa" href={`https://wa.me/${r.phone.replace(/\D/g, '').replace(/^0/, '91')}`} target="_blank" rel="noreferrer"><MessageCircle size={15}/> WhatsApp</a></td></tr>)}</tbody></table>{loading && <div className="table-loading">Loading live data...</div>}{!loading && !visible.length && <div className="table-loading">No participants found for this access.</div>}</div>
  </main>;
}

createRoot(document.getElementById('root')!).render(<App/>);