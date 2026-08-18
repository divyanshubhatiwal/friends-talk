// Anonymous display names. Nobody signs up, but a room still needs a handle
// to attach messages to, so every session gets a throwaway two-word name.

const ADJECTIVES = [
  'Amber', 'Brisk', 'Calm', 'Distant', 'Eager', 'Faint', 'Gentle', 'Hazy',
  'Idle', 'Jolly', 'Keen', 'Lucid', 'Mellow', 'Nimble', 'Open', 'Plain',
  'Quiet', 'Rapid', 'Silent', 'Tidal', 'Upbeat', 'Vivid', 'Warm', 'Zesty',
  'Northern', 'Copper', 'Velvet', 'Golden', 'Silver', 'Midnight'
];

const NOUNS = [
  'Harbor', 'Signal', 'Compass', 'Lantern', 'Meadow', 'Canyon', 'Orbit',
  'Ripple', 'Summit', 'Thicket', 'Willow', 'Anchor', 'Beacon', 'Cinder',
  'Drifter', 'Ember', 'Falcon', 'Glacier', 'Heron', 'Isle', 'Juniper',
  'Kestrel', 'Lagoon', 'Marble', 'Nomad', 'Otter', 'Prairie', 'Quartz'
];

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

export function randomName() {
  return `${pick(ADJECTIVES)} ${pick(NOUNS)}`;
}
