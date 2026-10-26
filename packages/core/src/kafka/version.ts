/**
 * Kafka does not report its version over the wire. A KRaft cluster reports its `metadata.version` feature level,
 * which names the release whose metadata format the cluster runs: levels from Kafka's MetadataVersion, by release.
 */
const RELEASE_FIRST_LEVEL: readonly [release: string, firstLevel: number][] = [
  ['3.0', 1],
  ['3.1', 2],
  ['3.2', 3],
  ['3.3', 4],
  ['3.4', 8],
  ['3.5', 9],
  ['3.6', 12],
  ['3.7', 15],
  ['3.8', 20],
  ['3.9', 21],
  ['4.0', 22],
  ['4.1', 26],
];

/** The newest level this table knows; a higher one is shown as `4.1+`. */
const LAST_KNOWN_LEVEL = 27;

/** `3.7` for metadata.version level 19; null for levels below 1. */
export function kafkaReleaseOfMetadataLevel(level: number): string | null {
  if (!Number.isInteger(level) || level < 1) return null;
  let release: string | null = null;
  for (const [name, first] of RELEASE_FIRST_LEVEL) if (level >= first) release = name;
  return level > LAST_KNOWN_LEVEL ? `${release}+` : release;
}
