-- TITAN v3: alert rules name the category of the incident they open, rules can be installed by
-- industry packs, and alarms carry the asset their device is attached to. Forward-only.

-- Category of the incident an alarm of this rule opens. NULL keeps the original behaviour (category 'general').
ALTER TABLE alert_rules ADD COLUMN incident_category text;
-- Pack that installed the rule. NULL: created by a person; a pack never changes such a rule.
ALTER TABLE alert_rules ADD COLUMN pack_id text;

-- Asset the device is attached to (from device.registered.v1), so an incident can refer to the asset.
ALTER TABLE device_names ADD COLUMN asset_id uuid;
