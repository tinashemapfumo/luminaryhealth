import React, { useEffect, useState } from 'react';
import {
  AlertTriangle, Building2, CalendarClock, Check, Copy, DoorOpen,
  Plug, ShieldCheck, Stethoscope, Trash2, UserPlus, Users, Wallet,
} from 'lucide-react';
import { Field, Input, Select, Button, EmptyState, Modal } from '../ui';
import { StatusPill } from '../shared/StatusPill';
import { useWorkspace } from '../../lib/workspace';
import { WEEKDAYS, CURRENCIES, SLOT_LENGTHS, IDLE_TIMEOUTS, expiringRegistrations } from '../../data/practiceSettings';
import { SELF_ELEVATION_BLOCKED } from '../../config/access';
import { api, isLive } from '../../services/api';

const TABS = [
  { id: 'profile', label: 'Practice', detail: 'Identity and billing defaults', icon: Building2 },
  { id: 'people', label: 'Users', detail: 'Roles, sessions, offboarding', icon: Users },
  { id: 'providers', label: 'Providers', detail: 'Clinical identities', icon: Stethoscope },
  { id: 'rooms', label: 'Rooms', detail: 'Bookable resources', icon: DoorOpen },
  { id: 'hours', label: 'Hours', detail: 'Calendar availability', icon: CalendarClock },
  { id: 'billing', label: 'Billing', detail: 'Schemes and tariffs', icon: Wallet },
  { id: 'integrations', label: 'Integrations', detail: 'Identifiers only', icon: Plug },
  { id: 'security', label: 'Security', detail: 'Access policy', icon: ShieldCheck },
];

const ROLE_LABELS = { admin: 'Administrator', doctor: 'Doctor', nurse: 'Nurse', manager: 'Practice manager', receptionist: 'Receptionist' };
const INVITABLE_ROLES = ['doctor', 'nurse', 'manager', 'receptionist'];

function Section({ title, detail, children, action }) {
  return (
    <section className="px-1 py-1">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3 border-b border-line/70 pb-3">
        <div>
          <h2 className="text-lg font-semibold tracking-[-0.01em] text-ink">{title}</h2>
          {detail && <p className="mt-1 max-w-2xl text-xs leading-5 text-muted">{detail}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}


const asTime = (value) => String(value || '').slice(0, 5);
const asString = (value, fallback = '') => (value === null || value === undefined ? fallback : String(value));

function settingsFromApi(payload, fallback) {
  const profile = payload.practice || {};
  const hours = payload.hours || {};
  const security = payload.security || {};
  const integrations = payload.integrations || {};

  return {
    ...fallback,
    profile: {
      ...fallback.profile,
      name: asString(profile.name, fallback.profile.name),
      short: asString(profile.short_name, fallback.profile.short),
      addressLine: asString(profile.address_line, fallback.profile.addressLine),
      city: asString(profile.city, fallback.profile.city),
      phone: asString(profile.phone, fallback.profile.phone),
      email: asString(profile.email, fallback.profile.email),
      primaryCurrency: asString(profile.primary_currency, fallback.profile.primaryCurrency),
      secondaryCurrency: asString(profile.secondary_currency, fallback.profile.secondaryCurrency),
      usdRate: profile.usd_rate ?? fallback.profile.usdRate,
    },
    providers: (payload.providers || []).map((provider) => ({
      id: provider.id,
      name: provider.display_name,
      speciality: provider.job_title || 'Clinician',
      registration: provider.registration_number || '',
      registrationExpires: provider.registration_expires || '',
      active: provider.active !== false,
    })),
    rooms: (payload.rooms || []).map((room) => ({
      id: room.id,
      name: room.name,
      kind: room.kind,
      active: room.active !== false,
    })),
    hours: {
      ...fallback.hours,
      opensAt: asTime(hours.opensAt),
      closesAt: asTime(hours.closesAt),
      slotMinutes: asString(hours.slotMinutes, fallback.hours.slotMinutes),
      openDays: hours.openDays || fallback.hours.openDays,
    },
    schemes: (payload.schemes || []).map((scheme) => ({
      id: scheme.id,
      payerId: scheme.payer_id || null,
      name: scheme.name,
      rate: Number(scheme.reimburse_percent ?? 0),
      requiresPreAuth: !!scheme.requires_preauth,
      active: scheme.active !== false,
    })),
    services: (payload.tariffs || []).map((tariff) => ({
      code: tariff.code,
      description: tariff.description,
      price: Number(tariff.price ?? 0),
      active: tariff.active !== false,
      currency: tariff.currency,
    })),
    integrations: {
      ...fallback.integrations,
      nh263ProviderNumber: asString(integrations.nh263ProviderNumber, fallback.integrations.nh263ProviderNumber),
      nh263Endpoint: asString(integrations.nh263Endpoint, fallback.integrations.nh263Endpoint),
      nh263Connected: Boolean(integrations.nh263ProviderNumber && integrations.nh263Endpoint),
      smsSender: asString(integrations.smsSenderId, fallback.integrations.smsSender),
      smsGateway: asString(integrations.smsGateway, fallback.integrations.smsGateway),
      smsConnected: Boolean(integrations.smsSenderId && integrations.smsGateway),
    },
    security: {
      ...fallback.security,
      idleTimeoutMinutes: asString(security.idleTimeoutMinutes, fallback.security.idleTimeoutMinutes),
      minimumPasswordLength: security.minimumPasswordLength ?? fallback.security.minimumPasswordLength,
      breakGlassEnabled: security.breakGlassEnabled ?? fallback.security.breakGlassEnabled,
      enforceRegistrationExpiry: security.enforceRegistration ?? fallback.security.enforceRegistrationExpiry,
    },
  };
}

function userFromApi(user) {
  return {
    id: user.id,
    role: user.role,
    name: user.display_name,
    fullName: user.full_name,
    email: user.email,
    jobTitle: user.job_title || '',
    hpcz: user.registration_number || '',
    active: user.active,
    lastSeenAt: user.last_seen_at,
    liveSessions: user.live_sessions,
    patients: user.patients,
    unsignedNotes: user.unsigned_notes,
  };
}

export default function SettingsPage() {
  const {
    access, currentUser, practice, settings: workspaceSettings, updateSettings,
    practiceUsers: workspaceUsers, updateUser: updateWorkspaceUser, notify, recordAudit,
    catalogue, tariffProvider, priceOn, triggerLabel, payers, openDialog,
  } = useWorkspace();

  const live = isLive();
  const [tab, setTab] = useState('profile');
  const [liveSettings, setLiveSettings] = useState(null);
  const [liveUsers, setLiveUsers] = useState(null);
  const [loadingAdmin, setLoadingAdmin] = useState(live);
  const [syncStatus, setSyncStatus] = useState(null);
  const [auditSummary, setAuditSummary] = useState(null);
  const [expiringLive, setExpiringLive] = useState([]);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteDraft, setInviteDraft] = useState({ fullName: '', email: '', role: 'receptionist', jobTitle: '' });
  const [inviteResult, setInviteResult] = useState(null);
  const settings = liveSettings || workspaceSettings;
  const practiceUsers = liveUsers || workspaceUsers;
  const canConfigure = access.can.manageConfiguration;
  const canManageCover = access.can.manageCover || canConfigure;
  const canManageUsers = access.can.manageUsers;

  const refreshAdmin = async () => {
    if (!live) return;
    setLoadingAdmin(true);
    try {
      const [remoteSettings, users, expiring, sync, audit] = await Promise.all([
        api.settings.get(),
        canManageUsers ? api.users.list() : Promise.resolve(null),
        canManageUsers ? api.users.expiringRegistrations(60) : Promise.resolve([]),
        access.can.manageConfiguration ? api.sync.status().catch(() => null) : Promise.resolve(null),
        access.can.reviewAudit ? api.audit.summary().catch(() => null) : Promise.resolve(null),
      ]);
      setLiveSettings(settingsFromApi(remoteSettings, workspaceSettings));
      if (users) setLiveUsers(users.map(userFromApi));
      setExpiringLive(expiring || []);
      setSyncStatus(sync);
      setAuditSummary(audit);
    } catch (error) {
      notify(error.message || 'Could not load administration data');
    } finally {
      setLoadingAdmin(false);
    }
  };

  useEffect(() => {
    refreshAdmin();
    // Deliberately keyed on identity, not on the loader. `refreshAdmin` closes
    // over the current settings, so listing it here would re-fire the effect on
    // every save it performs — refetching the thing that just changed, forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, currentUser.id]);

  const persistPatch = async (group, changes) => {
    if (!live) return;
    if (group === 'profile') {
      await api.settings.updatePractice({
        name: changes.name,
        shortName: changes.short,
        addressLine: changes.addressLine,
        city: changes.city,
        phone: changes.phone,
        email: changes.email,
        primaryCurrency: changes.primaryCurrency,
        secondaryCurrency: changes.secondaryCurrency,
        usdRate: changes.usdRate === undefined ? undefined : Number(changes.usdRate),
      });
    } else if (group === 'hours') {
      await api.settings.updateHours({
        ...changes,
        slotMinutes: changes.slotMinutes === undefined ? undefined : Number(changes.slotMinutes),
      });
    } else if (group === 'security') {
      await api.settings.updateSecurity({
        idleTimeoutMinutes: changes.idleTimeoutMinutes === undefined ? undefined : Number(changes.idleTimeoutMinutes),
        minimumPasswordLength: changes.minimumPasswordLength === undefined ? undefined : Number(changes.minimumPasswordLength),
        breakGlassEnabled: changes.breakGlassEnabled,
        enforceRegistration: changes.enforceRegistrationExpiry,
      });
    } else if (group === 'integrations') {
      await api.settings.updateIntegrations({
        nh263ProviderNumber: changes.nh263ProviderNumber,
        nh263Endpoint: changes.nh263Endpoint,
        smsSenderId: changes.smsSender,
        smsGateway: changes.smsGateway,
      });
    }
  };

  const patch = (group, changes) => {
    if (!canConfigure) return;
    const next = { ...settings, [group]: { ...settings[group], ...changes } };
    updateSettings(next);
    if (live) {
      setLiveSettings(next);
      persistPatch(group, changes).catch((error) => notify(error.message || 'Could not save setting'));
    }
  };
  const patchList = (group, list) => {
    if (group === 'schemes' ? !canManageCover : !canConfigure) return;
    const previous = settings[group] || [];
    const next = { ...settings, [group]: list };
    updateSettings(next);
    if (live) {
      setLiveSettings(next);
      persistList(group, previous, list).catch((error) => notify(error.message || 'Could not save setting'));
    }
  };

  const persistList = async (group, previous, list) => {
    if (group === 'schemes') {
      const changed = list.find((item) => {
        const before = previous.find((old) => old.id === item.id);
        return before && JSON.stringify(before) !== JSON.stringify(item);
      });
      if (changed) {
        await api.settings.updateScheme(changed.id, {
          reimbursePercent: Number(changed.rate),
          requiresPreauth: changed.requiresPreAuth,
          active: changed.active,
        });
      }
    } else if (group === 'services') {
      const changed = list.find((item) => {
        const before = previous.find((old) => old.code === item.code);
        return before && JSON.stringify(before) !== JSON.stringify(item);
      });
      if (changed) {
        await api.settings.upsertTariff({
          code: changed.code,
          description: changed.description,
          price: Number(changed.price),
          currency: changed.currency || settings.profile.primaryCurrency,
        });
      }
    } else if (group === 'rooms') {
      if (list.length > previous.length) {
        const created = list.find((item) => !previous.some((old) => old.id === item.id));
        if (created) {
          const room = await api.settings.createRoom({ name: created.name, kind: created.kind });
          await refreshAdmin();
          return room;
        }
      }
      if (list.length < previous.length) {
        const removed = previous.find((item) => !list.some((nextRoom) => nextRoom.id === item.id));
        if (removed) await api.settings.deleteRoom(removed.id);
        return;
      }
      const changed = list.find((item) => {
        const before = previous.find((old) => old.id === item.id);
        return before && JSON.stringify(before) !== JSON.stringify(item);
      });
      if (changed) await api.settings.updateRoom(changed.id, changed);
    }
  };

  const field = (group, key) => (event) => patch(group, { [key]: event.target.value });
  const lapsing = expiringRegistrations(settings);

  const openInvite = () => {
    setInviteDraft({ fullName: '', email: '', role: 'receptionist', jobTitle: '' });
    setInviteResult(null);
    setInviteOpen(true);
  };

  const inviteLink = inviteResult?.token
    ? `${window.location.origin}/?invite=${encodeURIComponent(inviteResult.token)}`
    : '';

  const copyInviteLink = async () => {
    if (!inviteLink) return;
    try {
      await navigator.clipboard.writeText(inviteLink);
      notify('Invitation link copied');
    } catch {
      notify('Copy failed. Select the link and copy it manually.');
    }
  };

  const submitInvite = async () => {
    if (!canManageUsers || inviteBusy) return;
    if (!inviteDraft.fullName.trim()) return notify('Enter the user name');
    if (!inviteDraft.email.trim()) return notify('Enter the user email');
    setInviteBusy(true);
    try {
      const result = await api.users.invite({
        fullName: inviteDraft.fullName.trim(),
        email: inviteDraft.email.trim(),
        role: inviteDraft.role,
        jobTitle: inviteDraft.jobTitle.trim() || undefined,
      });
      setInviteResult(result);
      await refreshAdmin();
      notify(`Invitation created for ${result.invitation.email}`);
    } catch (error) {
      notify(error.message || 'Could not invite user');
    } finally {
      setInviteBusy(false);
    }
    return undefined;
  };

  /** Separation of duty: an administrator may assign roles but never grant
   *  themselves clinical or financial authority. */
  const changeRole = (user, role) => {
    if (user.id === currentUser.id) {
      notify('You cannot change your own role. Ask another administrator');
      recordAudit({
        user: currentUser, action: 'Self-elevation blocked', subject: user.name,
        detail: `Attempted to change own role to ${role}`, severity: 'alert',
      });
      return;
    }
    if (live) {
      api.users.setRole(user.id, role)
        .then(() => {
          setLiveUsers((prev) => prev.map((u) => (u.id === user.id ? { ...u, role } : u)));
          notify(`${user.name} is now ${ROLE_LABELS[role]}. Existing sessions were revoked.`);
        })
        .catch((error) => notify(error.message || 'Could not change role'));
      return;
    }
    updateWorkspaceUser(user.id, { role });
    recordAudit({
      user: currentUser, action: 'Role changed', subject: user.name,
      detail: `${ROLE_LABELS[user.role]} → ${ROLE_LABELS[role]}`, severity: 'notice',
    });
    notify(`${user.name} is now ${ROLE_LABELS[role]}`);
  };

  const toggleActive = (user) => {
    if (user.id === currentUser.id) {
      notify('You cannot deactivate your own account');
      return;
    }
    const nowActive = user.active === false;
    if (live) {
      api.users.setActive(user.id, nowActive)
        .then(() => {
          setLiveUsers((prev) => prev.map((u) => (u.id === user.id ? { ...u, active: nowActive } : u)));
          notify(`${user.name} ${nowActive ? 'reactivated' : 'deactivated'}`);
        })
        .catch((error) => notify(error.message || 'Could not update account'));
      return;
    }
    updateWorkspaceUser(user.id, { active: nowActive });
    recordAudit({
      user: currentUser, action: nowActive ? 'User reactivated' : 'User deactivated',
      subject: user.name, severity: 'notice',
    });
    notify(`${user.name} ${nowActive ? 'reactivated' : 'deactivated'}`);
  };

  const revokeSessions = (user) => {
    if (!live) {
      notify('Session revocation is enforced by the live API');
      return;
    }
    api.users.revokeSessions(user.id)
      .then((result) => {
        setLiveUsers((prev) => prev.map((u) => (u.id === user.id ? { ...u, liveSessions: 0 } : u)));
        notify(`${result.revoked} active session${result.revoked === 1 ? '' : 's'} revoked for ${user.name}`);
      })
      .catch((error) => notify(error.message || 'Could not revoke sessions'));
  };

  const reviewOffboarding = (user) => {
    if (!live) {
      notify('Offboarding checks are enforced by the live API');
      return;
    }
    api.users.offboarding(user.id)
      .then((report) => {
        notify(`${report.user.name}: ${report.guidance}`);
      })
      .catch((error) => notify(error.message || 'Could not load offboarding report'));
  };

  return (
    <>
    <div className="space-y-6">
      <div className="lh-page-hero">
        <h1 className="lh-page-title">Settings</h1>
        <p className="lh-page-subtitle">{practice.name} configuration applies to this practice only.</p>
      </div>

      {!canConfigure && (
        <div className="flex items-start gap-2.5 rounded-lg border border-warning-line bg-warning-soft p-3">
          <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warning" />
          <p className="text-base leading-5 text-warning-deep">
            You can view this configuration but not change it. Editing requires the administrator role.
          </p>
        </div>
      )}

      {live && (
        <div className="grid gap-3 md:grid-cols-3">
          <div className="lh-metric">
            <p className="lh-section-label">Admin data</p>
            <p className="mt-2 text-lg font-semibold text-ink">{loadingAdmin ? 'Loading' : 'Live'}</p>
            <p className="mt-1 text-sm leading-5 text-body">
              Settings, users, roles, and policy changes save through the API.
            </p>
          </div>

          {syncStatus && (
            <div className="lh-metric">
              <p className="lh-section-label">Sync health</p>
              <p className="mt-2 text-lg font-semibold text-ink">{syncStatus.state}</p>
              <p className="mt-1 text-sm leading-5 text-body">
                {syncStatus.pendingChanges} pending · {syncStatus.openConflicts} conflict{syncStatus.openConflicts === 1 ? '' : 's'}
              </p>
            </div>
          )}

          {auditSummary && (
            <div className="lh-metric">
              <p className="lh-section-label">Audit window</p>
              <p className="mt-2 text-lg font-semibold text-ink">{auditSummary.totals?.events ?? 0} events</p>
              <p className="mt-1 text-sm leading-5 text-body">
                {auditSummary.totals?.alerts ?? 0} alerts · {auditSummary.liveAccessGrants ?? 0} live grants
              </p>
            </div>
          )}
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-[248px_minmax(0,1fr)]">
        <aside className="h-max rounded-lg border border-line/60 bg-white/45 p-1.5 backdrop-blur lg:sticky lg:top-0">
          <nav className="space-y-1">
            {TABS.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setTab(item.id)}
                className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition ${
                  tab === item.id ? 'bg-brand-soft text-brand-deep shadow-[0_8px_22px_-18px_rgba(8,114,222,0.55)]' : 'text-body hover:bg-surface'
                }`}
              >
                <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${
                  tab === item.id ? 'bg-white text-brand-deep' : 'bg-brand-soft text-brand-deep'
                }`}>
                  <item.icon size={15} />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-semibold">{item.label}</span>
                  <span className="mt-0.5 block truncate text-2xs text-muted">
                    {item.detail}
                  </span>
                </span>
              </button>
            ))}
          </nav>
        </aside>

        <div className="min-w-0 space-y-5">

      {tab === 'profile' && (
        <Section title="Practice profile" detail="Appears on invoices, patient messages, and claim submissions.">
          <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Practice name"><Input value={settings.profile.name} onChange={field('profile', 'name')} disabled={!canConfigure} /></Field>
            <Field label="Short name" hint="Used in tight spaces"><Input value={settings.profile.short} onChange={field('profile', 'short')} disabled={!canConfigure} /></Field>
            <Field label="Phone"><Input value={settings.profile.phone} onChange={field('profile', 'phone')} disabled={!canConfigure} /></Field>
            <div className="sm:col-span-2"><Field label="Address"><Input value={settings.profile.addressLine} onChange={field('profile', 'addressLine')} disabled={!canConfigure} /></Field></div>
            <Field label="City"><Input value={settings.profile.city} onChange={field('profile', 'city')} disabled={!canConfigure} /></Field>
            <Field label="Reception email"><Input value={settings.profile.email} onChange={field('profile', 'email')} disabled={!canConfigure} /></Field>
            <Field label="Billing currency"><Select value={settings.profile.primaryCurrency} onChange={field('profile', 'primaryCurrency')} options={CURRENCIES} disabled={!canConfigure} /></Field>
            <Field label="Secondary currency" hint="Quoted alongside"><Select value={settings.profile.secondaryCurrency} onChange={field('profile', 'secondaryCurrency')} options={CURRENCIES} disabled={!canConfigure} /></Field>
            <Field label="USD rate" hint="1 USD = n ZWL"><Input type="number" value={settings.profile.usdRate} onChange={field('profile', 'usdRate')} disabled={!canConfigure} /></Field>
          </div>
        </Section>
      )}

      {tab === 'people' && (
        <Section
          title="Users"
          detail="Accounts that can sign in to this practice. Deactivate rather than delete, because removing a user would break the audit trail that references them."
          action={canManageUsers && (
            <Button variant="secondary" type="button" onClick={openInvite}>
              <UserPlus size={13} /> Invite user
            </Button>
          )}
        >
          {expiringLive.length > 0 && (
            <div className="mb-4 flex items-start gap-2.5 rounded border border-warning-line bg-warning-soft p-3">
              <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warning" />
              <p className="text-base leading-5 text-warning-deep">
                <strong className="font-semibold">{expiringLive.length} registration{expiringLive.length === 1 ? '' : 's'} need review:</strong>{' '}
                {expiringLive.map((row) => `${row.display_name} (${row.registration_expires})`).join(', ')}.
              </p>
            </div>
          )}

          <div className="overflow-x-auto rounded-lg border border-line bg-white shadow-[0_8px_24px_-22px_rgba(11,21,36,0.5)]">
            <table className="min-w-full text-left text-md">
              <thead className="bg-surface text-xs font-medium text-muted">
                <tr>
                  <th className="px-4 py-3 font-medium">Name</th>
                  <th className="px-4 py-3 font-medium">Email</th>
                  <th className="px-4 py-3 font-medium">Role</th>
                  <th className="px-4 py-3 font-medium">Registration</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {practiceUsers.map((user) => {
                  const isSelf = user.id === currentUser.id;
                  return (
                    <tr key={user.id} className="border-t border-line transition hover:bg-surface">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-soft text-xs font-semibold text-brand-deep">
                            {(user.fullName || user.name || '?').split(' ').map((part) => part[0]).join('').slice(0, 2)}
                          </span>
                          <span>
                            <span className="font-medium text-ink">{user.fullName}</span>
                            {isSelf && <span className="ml-1.5 rounded-full bg-brand-soft px-1.5 py-0.5 text-2xs font-semibold uppercase text-brand-deep">you</span>}
                            <span className="block text-xs text-muted">{user.jobTitle}</span>
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-body">{user.email}</td>
                      <td className="px-4 py-3">
                        {canManageUsers && access.can.assignRoles && !isSelf ? (
                          <Select
                            value={user.role}
                            onChange={(e) => changeRole(user, e.target.value)}
                            options={Object.keys(ROLE_LABELS)}
                          />
                        ) : (
                          <span className="inline-flex rounded-lg bg-surface px-2.5 py-1.5 text-sm font-medium text-ink-soft">{ROLE_LABELS[user.role]}</span>
                        )}
                      </td>
                      <td className="py-2.5 text-body">{user.hpcz || 'Not recorded'}</td>
                      <td className="py-2.5">
                        <StatusPill label={user.active === false ? 'Deactivated' : user.onLeave ? 'On leave' : 'Active'}
                          tone={user.active === false ? 'alert' : user.onLeave ? 'warm' : 'success'} />
                      </td>
                      <td className="py-2.5 text-right">
                        {canManageUsers && !isSelf && (
                          <div className="flex justify-end gap-1.5">
                            <button type="button" onClick={() => reviewOffboarding(user)}
                              className="rounded border border-edge bg-white px-2.5 py-1.5 text-xs font-medium text-body transition hover:border-brand hover:text-brand">
                              Offboard
                            </button>
                            <button type="button" onClick={() => revokeSessions(user)}
                              className="rounded border border-edge bg-white px-2.5 py-1.5 text-xs font-medium text-body transition hover:border-warning hover:text-warning">
                              Revoke
                            </button>
                            <button type="button" onClick={() => toggleActive(user)}
                              className="rounded border border-danger-strong bg-white px-2.5 py-1.5 text-xs font-medium text-danger transition hover:border-danger hover:bg-danger-soft">
                              {user.active === false ? 'Reactivate' : 'Deactivate'}
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="mt-4 flex items-start gap-2.5 rounded border border-line bg-surface p-3">
            <ShieldCheck size={14} className="mt-0.5 shrink-0 text-brand" />
            <p className="text-sm leading-5 text-body">
              <strong className="font-semibold text-ink">Separation of duty.</strong> You cannot change your own role or
              deactivate your own account, and no role assignment can grant a permission the assigner does not hold.
              Blocked attempts are written to the audit log.
              {' '}Protected: {SELF_ELEVATION_BLOCKED.slice(0, 4).join(', ')}, and others.
            </p>
          </div>
        </Section>
      )}

      {tab === 'providers' && (
        <Section
          title="Providers"
          detail="Clinicians who appear as bookable columns on the calendar. A lapsed registration must block signing and prescribing, so expiry is tracked here."
        >
          {lapsing.length > 0 && (
            <div className="mb-4 flex items-start gap-2.5 rounded border border-warning-line bg-warning-soft p-3">
              <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warning" />
              <p className="text-base leading-5 text-warning-deep">
                <strong className="font-semibold">{lapsing.length} registration{lapsing.length > 1 ? 's' : ''} lapsing within 60 days:</strong>{' '}
                {lapsing.map((p) => `${p.name} (${p.registrationExpires})`).join(', ')}.
              </p>
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-md">
              <thead className="text-xs uppercase tracking-[0.08em] text-muted">
                <tr>
                  <th className="py-2 font-semibold">Provider</th>
                  <th className="py-2 font-semibold">Speciality</th>
                  <th className="py-2 font-semibold">Registration</th>
                  <th className="py-2 font-semibold">Expires</th>
                  <th className="py-2 font-semibold">Bookable</th>
                </tr>
              </thead>
              <tbody>
                {settings.providers.map((provider, index) => (
                  <tr key={provider.id} className="border-t border-line">
                    <td className="py-2.5 font-medium text-ink">{provider.name}</td>
                    <td className="py-2.5 text-body">{provider.speciality}</td>
                    <td className="py-2.5 text-body">{provider.registration}</td>
                    <td className="py-2.5">
                      <span className={lapsing.some((p) => p.id === provider.id) ? 'font-medium text-warning' : 'text-body'}>
                        {provider.registrationExpires}
                      </span>
                    </td>
                    <td className="py-2.5">
                      <label className="inline-flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={provider.active}
                          disabled={!canConfigure}
                          onChange={(e) => {
                            const next = [...settings.providers];
                            next[index] = { ...provider, active: e.target.checked };
                            patchList('providers', next);
                          }}
                          className="h-4 w-4 accent-brand"
                        />
                        <span className="text-sm text-body">{provider.active ? 'Yes' : 'No'}</span>
                      </label>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {tab === 'rooms' && (
        <Section title="Rooms and resources" detail="Bookable spaces. Deactivating a room removes it from the calendar without disturbing past appointments.">
          <div className="space-y-2">
            {settings.rooms.map((room, index) => (
              <div key={room.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-surface p-3">
                <Input
                  value={room.name}
                  disabled={!canConfigure}
                  onChange={(e) => {
                    const next = [...settings.rooms];
                    next[index] = { ...room, name: e.target.value };
                    patchList('rooms', next);
                  }}
                />
                <Select
                  value={room.kind}
                  disabled={!canConfigure}
                  options={['Consulting', 'Procedure', 'Treatment', 'Laboratory']}
                  onChange={(e) => {
                    const next = [...settings.rooms];
                    next[index] = { ...room, kind: e.target.value };
                    patchList('rooms', next);
                  }}
                />
                <label className="inline-flex items-center gap-2 text-sm text-body">
                  <input type="checkbox" checked={room.active} disabled={!canConfigure}
                    onChange={(e) => {
                      const next = [...settings.rooms];
                      next[index] = { ...room, active: e.target.checked };
                      patchList('rooms', next);
                    }}
                    className="h-4 w-4 accent-brand" />
                  Bookable
                </label>
                {canConfigure && (
                  <button type="button" aria-label={`Remove ${room.name}`}
                    onClick={() => patchList('rooms', settings.rooms.filter((r) => r.id !== room.id))}
                    className="ml-auto rounded p-1.5 text-muted transition hover:bg-danger-soft hover:text-danger">
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            ))}
          </div>
          {canConfigure && (
            <Button variant="secondary" type="button" className="mt-3"
              onClick={() => patchList('rooms', [...settings.rooms, { id: `R${Date.now().toString(36)}`, name: 'New room', kind: 'Consulting', active: true }])}>
              Add room
            </Button>
          )}
        </Section>
      )}

      {tab === 'hours' && (
        <Section title="Opening hours" detail="Drives the calendar grid. Appointments cannot be booked outside these hours.">
          <div className="grid gap-3.5 sm:grid-cols-3">
            <Field label="Opens at"><Input type="time" value={settings.hours.opensAt} onChange={field('hours', 'opensAt')} disabled={!canConfigure} /></Field>
            <Field label="Closes at"><Input type="time" value={settings.hours.closesAt} onChange={field('hours', 'closesAt')} disabled={!canConfigure} /></Field>
            <Field label="Slot length" hint="Minutes per calendar row"><Select value={settings.hours.slotMinutes} onChange={field('hours', 'slotMinutes')} options={SLOT_LENGTHS} disabled={!canConfigure} /></Field>
          </div>
          <p className="mb-2 mt-4 text-xs font-semibold uppercase tracking-[0.1em] text-muted">Open days</p>
          <div className="flex flex-wrap gap-1.5">
            {WEEKDAYS.map((day) => {
              const open = settings.hours.openDays.includes(day);
              return (
                <button
                  key={day}
                  type="button"
                  disabled={!canConfigure}
                  onClick={() => patch('hours', {
                    openDays: open ? settings.hours.openDays.filter((d) => d !== day) : [...settings.hours.openDays, day],
                  })}
                  className={`rounded px-3 py-1.5 text-sm font-medium transition ${
                    open ? 'bg-brand text-white' : 'bg-white text-muted ring-1 ring-inset ring-line'
                  } ${canConfigure ? '' : 'cursor-not-allowed opacity-70'}`}
                >
                  {open && <Check size={11} className="mr-1 inline" />}
                  {day.slice(0, 3)}
                </button>
              );
            })}
          </div>
        </Section>
      )}

      {tab === 'billing' && (
        <>
          <Section title="Medical aid schemes" detail="Reimbursement rate per scheme. This replaces a hardcoded 80% split that was computing real money from a guess.">
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-md">
                <thead className="text-xs uppercase tracking-[0.08em] text-muted">
                  <tr>
                    <th className="py-2 font-semibold">Scheme</th>
                    <th className="py-2 font-semibold">Reimburses</th>
                    <th className="py-2 font-semibold">Pre-authorisation</th>
                    <th className="py-2 font-semibold">Active</th>
                  </tr>
                </thead>
                <tbody>
                  {settings.schemes.map((scheme, index) => (
                    <tr key={scheme.id} className="border-t border-line">
                      <td className="py-2.5 font-medium text-ink">{scheme.name}</td>
                      <td className="py-2.5">
                        <span className="inline-flex items-center gap-1.5">
                          <input type="number" min="0" max="100" value={scheme.rate} disabled={!canManageCover}
                            onChange={(e) => {
                              const next = [...settings.schemes];
                              next[index] = { ...scheme, rate: Number(e.target.value) };
                              patchList('schemes', next);
                            }}
                            className="w-20 rounded border border-edge px-2 py-1 text-base text-ink outline-none focus:border-brand" />
                          <span className="text-sm text-muted">%</span>
                        </span>
                      </td>
                      <td className="py-2.5">
                        <StatusPill label={scheme.requiresPreAuth ? 'Required' : 'Not required'} tone={scheme.requiresPreAuth ? 'warm' : 'neutral'} />
                      </td>
                      <td className="py-2.5"><StatusPill label={scheme.active ? 'Active' : 'Inactive'} tone={scheme.active ? 'success' : 'neutral'} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          <Section
            title="Service catalogue"
            detail="What the practice does and what it charges. Prices are effective dated, so re-pricing a service never rewrites an invoice already raised under the old fee."
          >
            <div className="space-y-2">
              {catalogue.map((service) => {
                const price = priceOn(service);
                const rates = tariffProvider.current().filter((t) => t.serviceId === service.id);
                return (
                  <div key={service.id} className="lh-card-soft p-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-medium text-ink">{service.displayName}</p>
                        <p className="mt-1 text-sm text-body">
                          {service.department} · {service.billingDescription} · {service.defaultTariffCode}
                        </p>
                        <p className="mt-1 text-xs text-muted">
                          {triggerLabel(service.billingTrigger)}
                          {' · '}
                          {rates.length === 0
                            ? 'No negotiated rate. Priced by plan percentage'
                            : `${rates.length} medical aid ${rates.length === 1 ? 'tariff' : 'tariffs'}`}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-3 text-right">
                        <div>
                          <p className="text-base font-medium text-ink tabular-nums">
                            {price ? `${price.currency} ${price.amount.toFixed(2)}` : 'Not priced'}
                          </p>
                          <p className="text-xs text-muted">Practice price</p>
                        </div>
                        {canConfigure && (
                          <button
                            type="button"
                            onClick={() => openDialog('reprice', {
                              serviceId: service.id,
                              serviceName: service.displayName,
                              amount: price ? String(price.amount) : '',
                              currentPrice: price?.amount ?? 0,
                              effectiveFrom: new Date().toISOString().slice(0, 10),
                            })}
                            className="lh-secondary-button px-3 py-1.5"
                          >
                            Re-price
                          </button>
                        )}
                      </div>
                    </div>

                    {/* The payer rates behind the estimate, so a biller can see
                        why a line split the way it did without leaving Settings. */}
                    {rates.length > 0 && (
                      <div className="mt-2.5 space-y-1 border-t border-line pt-2.5">
                        {rates.map((rate) => (
                          <div key={rate.id} className="flex items-center justify-between text-xs">
                            <span className="text-body">
                              {(payers.find((p) => p.id === rate.payerId)?.plans ?? [])
                                .find((pl) => pl.id === rate.planId)?.name ?? 'All plans'}
                              {' · '}{rate.code}
                            </span>
                            <span className="tabular-nums text-ink">
                              {rate.currency} {Number(rate.rate).toFixed(2)}
                              <span className="ml-2 text-muted">
                                from {rate.effectiveFrom}{rate.effectiveTo ? ` to ${rate.effectiveTo}` : ''}
                              </span>
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </Section>
        </>
      )}

      {tab === 'integrations' && (
        <Section title="Integrations" detail="Credentials are per practice. Each clinic claims against the NH263 switch under its own provider number.">
          {!access.can.manageIntegrations ? (
            <EmptyState icon={ShieldCheck} title="Integration credentials are restricted" detail="Only an administrator can view or change these." />
          ) : (
            <div className="space-y-5">
              <div>
                <div className="mb-3 flex items-center gap-2">
                  <p className="text-sm font-semibold uppercase tracking-[0.1em] text-brand">NH263 claims switch</p>
                  <StatusPill label={settings.integrations.nh263Connected ? 'Connected' : 'Not connected'} tone={settings.integrations.nh263Connected ? 'success' : 'alert'} />
                </div>
                <div className="grid gap-3.5 sm:grid-cols-2">
                  <Field label="Provider number" hint="Issued by NH263 to this practice">
                    <Input value={settings.integrations.nh263ProviderNumber} onChange={field('integrations', 'nh263ProviderNumber')} disabled={!canConfigure} />
                  </Field>
                  <Field label="Endpoint">
                    <Input value={settings.integrations.nh263Endpoint} onChange={field('integrations', 'nh263Endpoint')} disabled={!canConfigure} />
                  </Field>
                </div>
              </div>

              <div className="border-t border-line pt-4">
                <div className="mb-3 flex items-center gap-2">
                  <p className="text-sm font-semibold uppercase tracking-[0.1em] text-brand">Messaging gateway</p>
                  <StatusPill label={settings.integrations.smsConnected ? 'Connected' : 'Not connected'} tone={settings.integrations.smsConnected ? 'success' : 'alert'} />
                </div>
                <div className="grid gap-3.5 sm:grid-cols-2">
                  <Field label="Sender ID" hint="Shown as the SMS sender"><Input value={settings.integrations.smsSender} onChange={field('integrations', 'smsSender')} disabled={!canConfigure} /></Field>
                  <Field label="Provider"><Select value={settings.integrations.smsGateway} onChange={field('integrations', 'smsGateway')} options={['Twilio', 'Africa’s Talking', 'Infobip']} disabled={!canConfigure} /></Field>
                </div>
              </div>

              <p className="flex items-start gap-1.5 rounded border border-warning-line bg-warning-soft p-3 text-sm leading-5 text-warning-deep">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                API secrets are never stored in the browser. When the backend lands these fields hold identifiers only; the secrets live server-side and are write-only from here.
              </p>
            </div>
          )}
        </Section>
      )}

      {tab === 'security' && (
        <Section title="Security policy" detail="Applies to everyone signing in to this practice.">
          <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Idle lock" hint="Minutes before the session locks">
              <Select value={settings.security.idleTimeoutMinutes} onChange={field('security', 'idleTimeoutMinutes')} options={IDLE_TIMEOUTS} disabled={!canConfigure} />
            </Field>
            <Field label="Minimum password length">
              <Input type="number" min="8" value={settings.security.minimumPasswordLength} onChange={field('security', 'minimumPasswordLength')} disabled={!canConfigure} />
            </Field>
          </div>

          <div className="mt-4 space-y-2.5">
            {[
              ['breakGlassEnabled', 'Allow break glass access', 'Clinicians may open a chart outside their care relationship, with a reason. Disabling this is dangerous: the covering doctor and the emergency case both lose their way through.'],
              ['breakGlassRequiresReason', 'Require a written reason', 'The reason is what makes break glass reviewable rather than decorative.'],
              ['enforceRegistrationExpiry', 'Block signing on lapsed registration', 'A clinician whose registration has expired cannot sign notes or prescribe.'],
            ].map(([key, label, detail]) => (
              <label key={key} className="flex items-start gap-2.5 rounded-lg border border-line bg-surface p-3">
                <input type="checkbox" checked={!!settings.security[key]} disabled={!canConfigure}
                  onChange={(e) => patch('security', { [key]: e.target.checked })}
                  className="mt-0.5 h-4 w-4 accent-brand" />
                <span>
                  <span className="block text-base font-medium text-ink">{label}</span>
                  <span className="mt-0.5 block text-sm leading-5 text-muted">{detail}</span>
                </span>
              </label>
            ))}
          </div>
        </Section>
      )}
        </div>
      </div>
    </div>

      <Modal
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        title={inviteResult ? 'Invitation created' : 'Invite user'}
        subtitle={inviteResult ? 'This link is shown once. Send it to the user through a trusted channel.' : 'The invited user chooses their own password.'}
        footer={inviteResult ? (
          <Button type="button" onClick={() => setInviteOpen(false)}>Done</Button>
        ) : (
          <>
            <Button variant="secondary" type="button" onClick={() => setInviteOpen(false)}>Cancel</Button>
            <Button type="button" onClick={submitInvite} disabled={inviteBusy}>
              {inviteBusy ? 'Creating...' : 'Create invite'}
            </Button>
          </>
        )}
      >
        {inviteResult ? (
          <div className="space-y-3.5">
            <Field label="Invite link">
              <div className="flex gap-2">
                <Input readOnly value={inviteLink} onFocus={(event) => event.target.select()} />
                <Button variant="secondary" type="button" onClick={copyInviteLink} aria-label="Copy invite link">
                  <Copy size={13} />
                </Button>
              </div>
            </Field>
            <Field label="Expires">
              <Input readOnly value={new Date(inviteResult.invitation.expires_at).toLocaleString()} />
            </Field>
          </div>
        ) : (
          <div className="grid gap-3.5 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <Field label="Full name" required>
                <Input value={inviteDraft.fullName} onChange={(event) => setInviteDraft((draft) => ({ ...draft, fullName: event.target.value }))} />
              </Field>
            </div>
            <div className="sm:col-span-2">
              <Field label="Work email" required>
                <Input type="email" value={inviteDraft.email} onChange={(event) => setInviteDraft((draft) => ({ ...draft, email: event.target.value }))} />
              </Field>
            </div>
            <Field label="Role" required>
              <Select
                value={inviteDraft.role}
                onChange={(event) => setInviteDraft((draft) => ({ ...draft, role: event.target.value }))}
                options={INVITABLE_ROLES}
                render={(role) => ROLE_LABELS[role]}
              />
            </Field>
            <Field label="Job title">
              <Input value={inviteDraft.jobTitle} onChange={(event) => setInviteDraft((draft) => ({ ...draft, jobTitle: event.target.value }))} />
            </Field>
          </div>
        )}
      </Modal>
    </>
  );
}
