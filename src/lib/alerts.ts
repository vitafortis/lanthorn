/**
 * Alert rules, channels and size history: shapes shared by the server and the browser.
 * Kept out of types.ts so the feature stays self-contained.
 */

export type AlertRuleKind = 'unreachable' | 'connections' | 'long_query' | 'size_above' | 'size_growth' | 'wraparound' | 'replication_lag';
export type Severity = 'critical' | 'warning';

export interface RuleParam {
	key: string;
	label: string;
	unit: string;
	min: number;
	max: number;
	default: number;
}

export interface RuleDef {
	label: string;
	description: string;
	severity: Severity;
	params: RuleParam[];
	/** Created enabled with the default rule set. */
	defaultEnabled: boolean;
	/** Only evaluated on Postgres connections. */
	postgresOnly?: boolean;
}

export const RULE_KINDS: AlertRuleKind[] = ['unreachable', 'connections', 'long_query', 'size_above', 'size_growth', 'wraparound', 'replication_lag'];

export const RULES: Record<AlertRuleKind, RuleDef> = {
	unreachable: {
		label: 'Database unreachable',
		description: 'pg·modern can’t connect for several checks in a row. Resolves (and notifies "recovered") once it answers again.',
		severity: 'critical',
		params: [{ key: 'failures', label: 'Consecutive failed checks', unit: 'checks', min: 1, max: 60, default: 2 }],
		defaultEnabled: true
	},
	connections: {
		label: 'Connections near the limit',
		description: 'Client connections in use, as a share of max_connections.',
		severity: 'warning',
		params: [{ key: 'percent', label: 'Used above', unit: '%', min: 1, max: 100, default: 80 }],
		defaultEnabled: true
	},
	long_query: {
		label: 'Long-running query',
		description: 'An active query has run longer than this. Idle sessions, replication and autovacuum are ignored.',
		severity: 'warning',
		params: [{ key: 'minutes', label: 'Running longer than', unit: 'min', min: 1, max: 1440, default: 15 }],
		defaultEnabled: true
	},
	size_above: {
		label: 'Database size above',
		description: 'The connection’s database (all user databases on a MySQL login without a default database) grows past a fixed size.',
		severity: 'warning',
		params: [{ key: 'gb', label: 'Size above', unit: 'GB', min: 0.1, max: 100000, default: 50 }],
		defaultEnabled: false
	},
	size_growth: {
		label: 'Fast database growth',
		description: 'The database grew by more than this in the last 24 hours (needs a day of size history).',
		severity: 'warning',
		params: [{ key: 'percent', label: 'Grew more than', unit: '% / 24h', min: 1, max: 10000, default: 25 }],
		defaultEnabled: true
	},
	wraparound: {
		label: 'Transaction ID wraparound',
		description: 'The oldest unfrozen transaction ID, age(datfrozenxid), as a share of the 2³¹ limit. Postgres only.',
		severity: 'critical',
		params: [{ key: 'percent', label: 'Age above', unit: '% of 2³¹', min: 1, max: 99, default: 50 }],
		defaultEnabled: true,
		postgresOnly: true
	},
	replication_lag: {
		label: 'Replication lag',
		description: 'Replay lag of any replica (on a primary) or of this server (on a replica). Skipped when there is no replication.',
		severity: 'warning',
		params: [{ key: 'seconds', label: 'Lag above', unit: 's', min: 1, max: 86400, default: 300 }],
		defaultEnabled: true
	}
};

export function isRuleKind(v: unknown): v is AlertRuleKind {
	return typeof v === 'string' && (RULE_KINDS as string[]).includes(v);
}

/** Default parameter values for a rule kind. */
export function defaultParams(kind: AlertRuleKind): Record<string, number> {
	return Object.fromEntries(RULES[kind].params.map((p) => [p.key, p.default]));
}

export interface AlertRule {
	id: string;
	kind: AlertRuleKind;
	/** null: every connection (unless a connection has its own rule of this kind). */
	connectionId: string | null;
	enabled: boolean;
	params: Record<string, number>;
	/** Also notify when the alert resolves ("recovered"). */
	notifyResolved: boolean;
	createdAt: string;
	updatedAt: string;
}

export type ChannelKind =
	| 'slack'
	| 'discord'
	| 'telegram'
	| 'pushover'
	| 'gotify'
	| 'ntfy'
	| 'matrix'
	| 'email'
	| 'homeassistant'
	| 'webhook'
	| 'apprise';

export interface ChannelField {
	key: string;
	label: string;
	placeholder?: string;
	/** Stored encrypted and never sent back to the browser. */
	secret?: boolean;
	required?: boolean;
	help?: string;
	/** How the value is checked and edited; text when absent. */
	type?: 'text' | 'url' | 'number' | 'select' | 'emails';
	options?: { value: string; label: string }[];
	/** Prefilled for a new channel. */
	default?: string;
	/** Only shown (and required) when another config field has one of these values. */
	showIf?: { key: string; values: string[] };
}

export const CHANNEL_KINDS: ChannelKind[] = ['slack', 'discord', 'telegram', 'pushover', 'gotify', 'ntfy', 'matrix', 'email', 'homeassistant', 'webhook', 'apprise'];

export const CHANNELS: Record<ChannelKind, { label: string; description: string; fields: ChannelField[] }> = {
	slack: {
		label: 'Slack',
		description: 'A Slack incoming webhook (api.slack.com/apps → Incoming Webhooks). Mattermost, Rocket.Chat and other Slack-compatible services work with the classic format.',
		fields: [
			{ key: 'url', label: 'Webhook URL', placeholder: 'https://hooks.slack.com/services/…', secret: true, required: true, type: 'url' },
			{
				key: 'format',
				label: 'Message format',
				type: 'select',
				default: 'blocks',
				options: [
					{ value: 'blocks', label: 'Block Kit (Slack)' },
					{ value: 'attachments', label: 'Classic attachment (Mattermost, Rocket.Chat…)' }
				]
			}
		]
	},
	discord: {
		label: 'Discord',
		description: 'A Discord channel webhook (Server settings → Integrations → Webhooks).',
		fields: [{ key: 'url', label: 'Webhook URL', placeholder: 'https://discord.com/api/webhooks/…', secret: true, required: true, type: 'url' }]
	},
	telegram: {
		label: 'Telegram',
		description: 'Messages from a Telegram bot (create one with @BotFather) to a chat, group or channel the bot is in.',
		fields: [
			{ key: 'botToken', label: 'Bot token', placeholder: '123456:ABC-DEF…', secret: true, required: true },
			{ key: 'chatId', label: 'Chat ID', placeholder: '-1001234567890 or @channelname', required: true },
			{ key: 'apiUrl', label: 'Bot API server', placeholder: 'https://api.telegram.org', type: 'url', help: 'Only for a self-hosted Bot API server.' }
		]
	},
	pushover: {
		label: 'Pushover',
		description: 'Push notifications through Pushover. Critical alerts are sent with high priority.',
		fields: [
			{ key: 'userKey', label: 'User or group key', secret: true, required: true },
			{ key: 'appToken', label: 'Application API token', secret: true, required: true },
			{ key: 'device', label: 'Device', placeholder: 'all devices' },
			{ key: 'sound', label: 'Sound', placeholder: 'default' }
		]
	},
	gotify: {
		label: 'Gotify',
		description: 'Messages to a Gotify application.',
		fields: [
			{ key: 'url', label: 'Server URL', placeholder: 'https://gotify.example.com', required: true, type: 'url' },
			{ key: 'token', label: 'Application token', secret: true, required: true }
		]
	},
	ntfy: {
		label: 'ntfy',
		description: 'Push notifications through ntfy.sh or your own ntfy server.',
		fields: [
			{ key: 'server', label: 'Server URL', placeholder: 'https://ntfy.sh', required: true, type: 'url', default: 'https://ntfy.sh' },
			{ key: 'topic', label: 'Topic', placeholder: 'homelab-databases', required: true },
			{ key: 'token', label: 'Access token', placeholder: 'tk_… (optional)', secret: true }
		]
	},
	matrix: {
		label: 'Matrix',
		description: 'Messages to a Matrix room as a (bot) user. Invite the user to the room first.',
		fields: [
			{ key: 'homeserver', label: 'Homeserver URL', placeholder: 'https://matrix.example.org', required: true, type: 'url' },
			{ key: 'room', label: 'Room ID or alias', placeholder: '!abcdef:example.org or #alerts:example.org', required: true },
			{ key: 'token', label: 'Access token', secret: true, required: true }
		]
	},
	email: {
		label: 'Email (SMTP)',
		description: 'Email through any SMTP server. Use implicit TLS on port 465 or STARTTLS on 587.',
		fields: [
			{ key: 'host', label: 'SMTP host', placeholder: 'smtp.example.com', required: true },
			{ key: 'port', label: 'Port', placeholder: '587', type: 'number', default: '587' },
			{
				key: 'security',
				label: 'Encryption',
				type: 'select',
				default: 'starttls',
				options: [
					{ value: 'starttls', label: 'STARTTLS (usually 587)' },
					{ value: 'tls', label: 'TLS (usually 465)' },
					{ value: 'none', label: 'None (trusted network only)' }
				]
			},
			{ key: 'username', label: 'Username', placeholder: 'optional' },
			{ key: 'password', label: 'Password', secret: true },
			{ key: 'from', label: 'From', placeholder: 'pg·modern <alerts@example.com>', required: true },
			{ key: 'to', label: 'To', placeholder: 'you@example.com, ops@example.com', required: true, type: 'emails' },
			{
				key: 'verifyCert',
				label: 'Server certificate',
				type: 'select',
				default: 'verify',
				options: [
					{ value: 'verify', label: 'Verify' },
					{ value: 'skip', label: 'Accept self-signed' }
				]
			}
		]
	},
	homeassistant: {
		label: 'Home Assistant',
		description: 'A Home Assistant automation webhook, or a notify service (e.g. the companion app) called with a long-lived access token.',
		fields: [
			{ key: 'url', label: 'Home Assistant URL', placeholder: 'http://homeassistant.local:8123', required: true, type: 'url' },
			{
				key: 'mode',
				label: 'Send with',
				type: 'select',
				default: 'webhook',
				options: [
					{ value: 'webhook', label: 'Automation webhook' },
					{ value: 'service', label: 'Notify service' }
				]
			},
			{ key: 'webhookId', label: 'Webhook ID', secret: true, required: true, showIf: { key: 'mode', values: ['webhook'] } },
			{ key: 'service', label: 'Notify service', placeholder: 'mobile_app_pixel_8', required: true, showIf: { key: 'mode', values: ['service'] }, help: 'The part after notify., e.g. mobile_app_pixel_8.' },
			{ key: 'token', label: 'Long-lived access token', secret: true, required: true, showIf: { key: 'mode', values: ['service'] } }
		]
	},
	webhook: {
		label: 'Webhook (JSON)',
		description: 'POSTs a JSON document to any URL (n8n, Node-RED, your own service).',
		fields: [
			{ key: 'url', label: 'URL', placeholder: 'https://example.com/hooks/pg-modern', secret: true, required: true, type: 'url' },
			{ key: 'authorization', label: 'Authorization header', placeholder: 'Bearer … (optional)', secret: true }
		]
	},
	apprise: {
		label: 'Apprise API',
		description: 'An Apprise API notify endpoint, which fans out to anything Apprise supports.',
		fields: [
			{ key: 'url', label: 'Notify URL', placeholder: 'http://apprise:8000/notify/pg-modern', secret: true, required: true, type: 'url' },
			{ key: 'tag', label: 'Tag', placeholder: 'optional' }
		]
	}
};

export function isChannelKind(v: unknown): v is ChannelKind {
	return typeof v === 'string' && (CHANNEL_KINDS as string[]).includes(v);
}

/** Whether a field applies given the channel's other settings (see `showIf`). */
export function fieldVisible(f: ChannelField, config: Record<string, string | undefined>, kind?: ChannelKind): boolean {
	if (!f.showIf) return true;
	const dep = kind ? CHANNELS[kind].fields.find((x) => x.key === f.showIf!.key) : undefined;
	const v = config[f.showIf.key] || dep?.default || '';
	return f.showIf.values.includes(v);
}

/** Which alerts reach a channel, and when. Not secret: shown and edited in the browser. */
export interface ChannelOptions {
	/** Only alerts at least this severe. */
	minSeverity: Severity;
	/** Rule kinds that reach this channel; empty: all. */
	ruleKinds: AlertRuleKind[];
	/** Connection ids that reach this channel; empty: all. */
	connectionIds: string[];
	/** Also send "resolved" notifications (the rule's own setting still applies). */
	sendResolved: boolean;
	/** Also send "still firing" reminders. */
	sendRenotify: boolean;
	quietHours: QuietHours;
	/** At most this many notifications an hour; 0 = no limit. */
	maxPerHour: number;
	/** Drop a repeat of the same alert event within this many minutes; 0 = off. */
	dedupeMinutes: number;
}

export interface QuietHours {
	enabled: boolean;
	/** "HH:MM", local to `timezone`. */
	start: string;
	end: string;
	/** IANA zone; '' means the server's. */
	timezone: string;
	/** Critical alerts (and their recovery) are still sent during quiet hours. */
	allowCritical: boolean;
}

export const DEFAULT_CHANNEL_OPTIONS: ChannelOptions = {
	minSeverity: 'warning',
	ruleKinds: [],
	connectionIds: [],
	sendResolved: true,
	sendRenotify: true,
	quietHours: { enabled: false, start: '22:00', end: '07:00', timezone: '', allowCritical: true },
	maxPerHour: 30,
	dedupeMinutes: 5
};

/** A channel as the browser sees it: secrets only as "set" plus a harmless hint. */
export interface AlertChannel {
	id: string;
	name: string;
	kind: ChannelKind;
	enabled: boolean;
	config: Record<string, string>;
	options: ChannelOptions;
	/** Secret field → a redacted hint (e.g. `discord.com/…`); absent when not set. */
	secrets: Record<string, string>;
	lastSentAt: string | null;
	lastError: string | null;
	createdAt: string;
}

export type DeliveryStatus = 'sending' | 'sent' | 'failed' | 'suppressed';

/** One attempt (or deliberate skip) to notify one channel. */
export interface AlertDelivery {
	id: number;
	at: string;
	channelId: string | null;
	channelName: string;
	channelKind: ChannelKind;
	eventId: number | null;
	event: AlertTransition | 'test';
	severity: Severity;
	title: string;
	connectionName: string | null;
	status: DeliveryStatus;
	/** Why it was suppressed, or the service's error. */
	detail: string | null;
	durationMs: number | null;
}

export type AlertTransition = 'fired' | 'resolved' | 'renotified';

export interface AlertEvent {
	id: number;
	at: string;
	ruleId: string | null;
	ruleKind: AlertRuleKind;
	connectionId: string | null;
	connectionName: string | null;
	event: AlertTransition;
	severity: Severity;
	message: string;
	/** Channels the notification reached. */
	delivered: number;
	error: string | null;
}

export interface ActiveAlert {
	ruleId: string;
	ruleKind: AlertRuleKind;
	connectionId: string;
	connectionName: string;
	severity: Severity;
	since: string;
	message: string;
	lastNotifiedAt: string | null;
}

export interface AlertSettings {
	/** How often checks run. */
	intervalSeconds: number;
	/** Re-notify a still-firing alert after this long; 0 never. */
	renotifyHours: number;
	/** pg·modern's address, for links in notifications. */
	publicUrl: string;
}

export const DEFAULT_ALERT_SETTINGS: AlertSettings = { intervalSeconds: 60, renotifyHours: 6, publicUrl: '' };

/** Firing alerts for one connection, for badges. */
export interface FiringSummary {
	count: number;
	critical: boolean;
	titles: string[];
}

// --- size history ------------------------------------------------------------------

export type GrowthRange = '7d' | '30d' | '1y';
export const GROWTH_RANGES: GrowthRange[] = ['7d', '30d', '1y'];

export interface SizePoint {
	/** Epoch ms. */
	at: number;
	bytes: number;
}

export interface TableGrowth {
	schema: string;
	name: string;
	bytes: number;
	/** Change since the first sample in the range. */
	delta: number;
	/** null when the table first appeared in the range. */
	deltaPct: number | null;
}

export interface GrowthData {
	range: GrowthRange;
	series: SizePoint[];
	tables: TableGrowth[];
	lastSampleAt: number | null;
}
