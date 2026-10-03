import { createHash } from 'node:crypto';
import { ScanCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
const STAGES = new Set(['dev', 'test', 'prod']);
const OPERATIONS = new Set(['inventory', 'backfill', 'reconcile']);
const PRODUCTION_ACCOUNT_ID = '765932874577';
const SAFE_PROJECTION = [
  'pk',
  'sk',
  'userId',
  'accountType',
  '#status',
  'createdAt',
  '#kind',
  'guardianId',
  'minorId',
  'linkId',
  'gsi1pk',
  'gsi1sk',
  'entityType',
  'householdId',
  'primaryResponsibleId',
  'country',
  '#state',
  'revision',
  'updatedAt',
  'seatType',
  'seatNumber',
  'accountId',
  'assignedAt',
  'adultId',
  '#role',
  'validFrom',
  'validUntil',
].join(', ');
const SAFE_NAMES = Object.freeze({
  '#status': 'status',
  '#kind': 'kind',
  '#state': 'state',
  '#role': 'role',
});

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isIdentifier(value) {
  return typeof value === 'string' && IDENTIFIER.test(value);
}

function isTimestamp(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function householdIdForPrimary(primaryResponsibleId) {
  return `hh_${createHash('sha256')
    .update('roadmap2u:household:v2\0', 'utf8')
    .update(primaryResponsibleId, 'utf8')
    .digest('hex')}`;
}

function supervisionLinkId(householdId, minorId, adultId) {
  return `sl_${createHash('sha256')
    .update('roadmap2u:supervision:v2\0', 'utf8')
    .update(householdId, 'utf8')
    .update('\0', 'utf8')
    .update(minorId, 'utf8')
    .update('\0', 'utf8')
    .update(adultId, 'utf8')
    .digest('hex')}`;
}

function parseProfile(item) {
  if (
    !isObject(item) ||
    item.sk !== 'PROFILE' ||
    !isIdentifier(item.userId) ||
    item.pk !== `USER#${item.userId}` ||
    (item.accountType !== 'adult' && item.accountType !== 'minor') ||
    !isTimestamp(item.createdAt) ||
    (item.status !== undefined && item.status !== 'active' && item.status !== 'closing')
  ) {
    return null;
  }
  return item;
}

function isProfileShape(item) {
  return (
    isObject(item) &&
    item.sk === 'PROFILE' &&
    ((typeof item.pk === 'string' && item.pk.startsWith('USER#')) ||
      typeof item.userId === 'string')
  );
}

function isLegacyLinkShape(item) {
  return (
    isObject(item) &&
    (item.kind === 'created' || item.kind === 'invited' ||
      (typeof item.sk === 'string' && item.sk.startsWith('GUARDIAN#')))
  );
}

function parseLegacyLink(item) {
  if (
    !isObject(item) ||
    (item.kind !== 'created' && item.kind !== 'invited') ||
    !isIdentifier(item.guardianId) ||
    !isIdentifier(item.minorId) ||
    item.guardianId === item.minorId ||
    !isTimestamp(item.createdAt) ||
    item.pk !== `USER#${item.minorId}` ||
    item.sk !== `GUARDIAN#${item.guardianId}` ||
    item.gsi1pk !== `USER#${item.guardianId}` ||
    item.gsi1sk !== `MINOR#${item.minorId}` ||
    item.linkId !== `${item.guardianId}~${item.minorId}`
  ) {
    return null;
  }
  return item;
}

function attributableMinorIds(item) {
  const ids = new Set();
  if (isIdentifier(item?.minorId)) ids.add(item.minorId);
  for (const [field, prefix] of [
    ['pk', 'USER#'],
    ['gsi1sk', 'MINOR#'],
  ]) {
    const value = item?.[field];
    if (typeof value === 'string' && value.startsWith(prefix)) {
      const accountId = value.slice(prefix.length);
      if (isIdentifier(accountId)) ids.add(accountId);
    }
  }
  return ids;
}

function legacyLinkOrder(left, right) {
  return (
    left.createdAt - right.createdAt ||
    left.guardianId.localeCompare(right.guardianId) ||
    left.kind.localeCompare(right.kind)
  );
}

function householdKey(householdId) {
  return `HOUSEHOLD#${householdId}`;
}

function itemAddress(item) {
  return `${item.pk}\0${item.sk}`;
}

function sameItem(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function buildHouseholdItems({ primary, entries, additionalResponsibleId, state }) {
  const householdId = householdIdForPrimary(primary.userId);
  const sourceLinks = entries.flatMap(({ sourceLinks }) => sourceLinks);
  const createdAt = sourceLinks.reduce(
    (earliest, link) => Math.min(earliest, link.createdAt),
    primary.createdAt,
  );
  const household = {
    pk: householdKey(householdId),
    sk: 'META',
    entityType: 'Household',
    householdId,
    primaryResponsibleId: primary.userId,
    country: 'MX',
    state,
    revision: 1,
    createdAt,
    updatedAt: createdAt,
  };
  const ordered = [...entries].sort((left, right) => left.minorId.localeCompare(right.minorId));
  const assignableEntries = state === 'legacy_over_capacity' ? [] : ordered;
  const minorSeats = [1, 2].map((seatNumber, index) => {
    const entry = assignableEntries[index];
    return {
      pk: householdKey(householdId),
      sk: `SEAT#MINOR#${seatNumber}`,
      entityType: 'SeatAssignment',
      householdId,
      seatType: 'minor',
      seatNumber,
      state: entry ? 'assigned' : 'empty',
      accountId: entry?.minorId ?? null,
      revision: 1,
      assignedAt: entry?.primaryLink.createdAt ?? null,
      updatedAt: entry?.primaryLink.createdAt ?? createdAt,
    };
  });
  const additionalLinks = assignableEntries
    .map(({ additionalLink }) => additionalLink)
    .filter(Boolean)
    .sort(legacyLinkOrder);
  const additionalSeat = {
    pk: householdKey(householdId),
    sk: 'SEAT#ADDITIONAL',
    entityType: 'SeatAssignment',
    householdId,
    seatType: 'additional_responsible',
    state: additionalResponsibleId ? 'assigned' : 'empty',
    accountId: additionalResponsibleId,
    revision: 1,
    assignedAt: additionalLinks[0]?.createdAt ?? null,
    updatedAt: additionalLinks[0]?.createdAt ?? createdAt,
  };
  const links = assignableEntries.flatMap((entry) => {
    const primaryLink = {
      pk: `USER#${entry.minorId}`,
      sk: `SUPERVISION#${primary.userId}`,
      gsi1pk: `USER#${primary.userId}`,
      gsi1sk: `SUPERVISION#${entry.minorId}`,
      entityType: 'SupervisionLink',
      linkId: supervisionLinkId(householdId, entry.minorId, primary.userId),
      householdId,
      adultId: primary.userId,
      minorId: entry.minorId,
      role: 'primary_responsible',
      state: 'active',
      revision: 1,
      validFrom: entry.primaryLink.createdAt,
      validUntil: null,
      updatedAt: entry.primaryLink.createdAt,
    };
    if (!entry.additionalLink) return [primaryLink];
    const additionalLink = {
      pk: `USER#${entry.minorId}`,
      sk: `SUPERVISION#${entry.additionalLink.guardianId}`,
      gsi1pk: `USER#${entry.additionalLink.guardianId}`,
      gsi1sk: `SUPERVISION#${entry.minorId}`,
      entityType: 'SupervisionLink',
      linkId: supervisionLinkId(
        householdId,
        entry.minorId,
        entry.additionalLink.guardianId,
      ),
      householdId,
      adultId: entry.additionalLink.guardianId,
      minorId: entry.minorId,
      role: 'additional_responsible',
      state: 'active',
      revision: 1,
      validFrom: entry.additionalLink.createdAt,
      validUntil: null,
      updatedAt: entry.additionalLink.createdAt,
    };
    return [primaryLink, additionalLink];
  });
  return [household, ...minorSeats, additionalSeat, ...links];
}

function dispositionFor(items, existingByAddress) {
  const existing = items.map((item) => existingByAddress.get(itemAddress(item)));
  if (existing.every((item) => item === undefined)) return 'candidate';
  if (existing.every((item, index) => item !== undefined && sameItem(item, items[index]))) {
    return 'already';
  }
  return 'drift';
}

function pushIndex(map, key, item) {
  const values = map.get(key) ?? [];
  values.push(item);
  map.set(key, values);
}

function buildFamilyItemIndex(items) {
  const coreByPartition = new Map();
  const householdByPrimary = new Map();
  const activeSupervisionByHousehold = new Map();
  const activeSupervisionByMinor = new Map();
  for (const item of items) {
    if (!isObject(item) || typeof item.pk !== 'string' || typeof item.sk !== 'string') {
      continue;
    }
    if (item.entityType === 'Household') {
      pushIndex(coreByPartition, item.pk, item);
      if (isIdentifier(item.primaryResponsibleId)) {
        pushIndex(householdByPrimary, item.primaryResponsibleId, item);
      }
      continue;
    }
    if (item.entityType === 'SeatAssignment') {
      pushIndex(coreByPartition, item.pk, item);
      continue;
    }
    if (item.entityType === 'SupervisionLink' && item.state === 'active') {
      if (isIdentifier(item.householdId)) {
        pushIndex(activeSupervisionByHousehold, item.householdId, item);
      }
      if (isIdentifier(item.minorId)) {
        pushIndex(activeSupervisionByMinor, item.minorId, item);
      }
    }
  }
  return {
    coreByPartition,
    householdByPrimary,
    activeSupervisionByHousehold,
    activeSupervisionByMinor,
  };
}

function hasUnexpectedFamilyItems(plan, index) {
  const expectedAddresses = new Set(plan.items.map(itemAddress));
  const householdPartition = householdKey(plan.householdId);
  const minorIds = new Set(plan.minorIds);
  const candidates = [
    ...(index.coreByPartition.get(householdPartition) ?? []),
    ...(index.householdByPrimary.get(plan.primaryResponsibleId) ?? []),
    ...(index.activeSupervisionByHousehold.get(plan.householdId) ?? []),
    ...plan.minorIds.flatMap(
      (minorId) => index.activeSupervisionByMinor.get(minorId) ?? [],
    ),
  ];
  return candidates.some((item) => {
    const address = itemAddress(item);
    if (expectedAddresses.has(address)) return false;
    if (
      (item.entityType === 'Household' || item.entityType === 'SeatAssignment') &&
      (item.pk === householdPartition ||
        (item.entityType === 'Household' &&
          item.primaryResponsibleId === plan.primaryResponsibleId))
    ) {
      return true;
    }
    return (
      item.entityType === 'SupervisionLink' &&
      item.state === 'active' &&
      (item.householdId === plan.householdId || minorIds.has(item.minorId))
    );
  });
}

/**
 * Builds a deterministic, in-memory migration plan from a consistent table
 * scan. Raw identities stay inside the plan; callers must publish only the
 * aggregate manifest returned by runFamilyModelMigration.
 */
export function classifyLegacyFamilyModel(items = []) {
  if (!Array.isArray(items)) throw new Error('items must be an array');
  const profiles = new Map();
  const existingByAddress = new Map();
  const structurallyValidLinks = [];
  const closingAccountIds = new Set();
  const blockedMinorIds = new Set();
  const blockedAdultHouseholdIds = new Set();
  let blockAllHouseholds = false;
  let validLegacyLinks = 0;
  const classifications = {
    eligible: 0,
    alreadyBackfilled: 0,
    legacyOverCapacity: 0,
    ambiguousHouseholds: 0,
    minorsWithoutCreatedGuardian: 0,
    invalidLinks: 0,
    orphanedLinks: 0,
    existingDrift: 0,
    closingAccounts: 0,
    closingHouseholds: 0,
    emptyAdultHouseholds: 0,
    invalidProfiles: 0,
  };
  let legacyLinks = 0;
  for (const item of items) {
    const profile = parseProfile(item);
    if (profile) {
      profiles.set(profile.userId, profile);
      if (profile.status === 'closing') closingAccountIds.add(profile.userId);
    } else if (isProfileShape(item)) {
      classifications.invalidProfiles += 1;
    }
    if (
      isObject(item) &&
      item.sk === 'STATE' &&
      typeof item.pk === 'string' &&
      item.pk.startsWith('ACCOUNT_CLOSURE#')
    ) {
      const accountId = item.pk.slice('ACCOUNT_CLOSURE#'.length);
      if (isIdentifier(accountId)) closingAccountIds.add(accountId);
    }
    if (isObject(item) && typeof item.pk === 'string' && typeof item.sk === 'string') {
      existingByAddress.set(itemAddress(item), item);
    }
    if (!isLegacyLinkShape(item)) continue;
    legacyLinks += 1;
    const link = parseLegacyLink(item);
    if (link) structurallyValidLinks.push(link);
    else {
      classifications.invalidLinks += 1;
      const attributed = attributableMinorIds(item);
      if (attributed.size === 0) blockAllHouseholds = true;
      for (const minorId of attributed) blockedMinorIds.add(minorId);
    }
  }
  const familyItemIndex = buildFamilyItemIndex(items);

  const linksByMinor = new Map();
  for (const link of structurallyValidLinks) {
    const guardian = profiles.get(link.guardianId);
    const minor = profiles.get(link.minorId);
    if (!guardian || !minor || guardian.accountType !== 'adult' || minor.accountType !== 'minor') {
      classifications.orphanedLinks += 1;
      if (minor?.accountType === 'minor') blockedMinorIds.add(link.minorId);
      if (guardian?.accountType === 'adult') blockedAdultHouseholdIds.add(link.guardianId);
      continue;
    }
    validLegacyLinks += 1;
    const links = linksByMinor.get(link.minorId) ?? [];
    if (!links.some((candidate) => candidate.guardianId === link.guardianId)) links.push(link);
    linksByMinor.set(link.minorId, links);
  }

  const groups = new Map();
  for (const minor of [...profiles.values()].filter((item) => item.accountType === 'minor')) {
    const links = [...(linksByMinor.get(minor.userId) ?? [])].sort(legacyLinkOrder);
    const created = links.filter((link) => link.kind === 'created').sort(legacyLinkOrder);
    if (created.length === 0) {
      classifications.minorsWithoutCreatedGuardian += 1;
      for (const link of links) blockedAdultHouseholdIds.add(link.guardianId);
      continue;
    }
    const primaryLink = created[0];
    const remaining = links
      .filter((link) => link.guardianId !== primaryLink.guardianId)
      .sort(legacyLinkOrder);
    const group = groups.get(primaryLink.guardianId) ?? {
      primary: profiles.get(primaryLink.guardianId),
      entries: [],
      ambiguous: false,
    };
    group.entries.push({
      minorId: minor.userId,
      primaryLink,
      additionalLink: remaining[0] ?? null,
      sourceLinks: [primaryLink, ...remaining],
    });
    if (remaining.length > 1) group.ambiguous = true;
    groups.set(primaryLink.guardianId, group);
  }

  // New adult accounts are born with this empty graph in post-confirmation.
  // Legacy adults need the same deterministic baseline even when they have no
  // minors, including adults who are additional in somebody else's household.
  for (const adult of [...profiles.values()].filter((item) => item.accountType === 'adult')) {
    if (!groups.has(adult.userId)) {
      groups.set(adult.userId, { primary: adult, entries: [], ambiguous: false });
    }
  }

  const plans = [];
  for (const group of groups.values()) {
    const entries = [...group.entries].sort((left, right) =>
      left.minorId.localeCompare(right.minorId),
    );
    const additionalIds = new Set(
      entries.map(({ additionalLink }) => additionalLink?.guardianId).filter(Boolean),
    );
    const state = entries.length > 2 ? 'legacy_over_capacity' : 'active';
    if (entries.length === 0) classifications.emptyAdultHouseholds += 1;
    // Over-capacity households receive only a blocking marker. Their legacy
    // links remain authoritative, so conflicting additional adults must not
    // prevent us from recording the safer commercial state.
    const ambiguous =
      state === 'active' &&
      (blockAllHouseholds ||
        blockedAdultHouseholdIds.has(group.primary.userId) ||
        group.ambiguous ||
        additionalIds.size > 1 ||
        entries.some(({ minorId }) => blockedMinorIds.has(minorId)));
    const additionalResponsibleId =
      state === 'active' && additionalIds.size === 1 ? [...additionalIds][0] : null;
    const planItems = buildHouseholdItems({
      primary: group.primary,
      entries,
      additionalResponsibleId,
      state,
    });
    const planShape = {
      primaryResponsibleId: group.primary.userId,
      householdId: householdIdForPrimary(group.primary.userId),
      minorIds: entries.map(({ minorId }) => minorId),
      items: planItems,
    };
    const closureAccounts = new Set([
      group.primary.userId,
      ...entries.map(({ minorId }) => minorId),
      ...entries.flatMap(({ sourceLinks }) => sourceLinks.map(({ guardianId }) => guardianId)),
    ]);
    const closing = [...closureAccounts].some((accountId) => closingAccountIds.has(accountId));
    let disposition = closing
      ? 'closing'
      : ambiguous
        ? 'ambiguous'
        : dispositionFor(planItems, existingByAddress);
    if (
      disposition !== 'closing' &&
      disposition !== 'ambiguous' &&
      hasUnexpectedFamilyItems(planShape, familyItemIndex)
    ) {
      disposition = 'drift';
    }
    if (state === 'legacy_over_capacity') classifications.legacyOverCapacity += 1;
    if (closing) classifications.closingHouseholds += 1;
    else if (ambiguous) classifications.ambiguousHouseholds += 1;
    else if (disposition === 'candidate') classifications.eligible += 1;
    else if (disposition === 'already') classifications.alreadyBackfilled += 1;
    else classifications.existingDrift += 1;
    plans.push({
      primaryResponsibleId: group.primary.userId,
      householdId: householdIdForPrimary(group.primary.userId),
      state,
      disposition,
      minorIds: entries.map(({ minorId }) => minorId),
      additionalResponsibleId,
      additionalScope: entries
        .filter(({ additionalLink }) => additionalLink?.guardianId === additionalResponsibleId)
        .map(({ minorId }) => minorId),
      sourceLinks: entries.flatMap(({ primaryLink, sourceLinks }) =>
        state === 'legacy_over_capacity' ? [primaryLink] : sourceLinks,
      ),
      involvedAccountIds: [
        group.primary.userId,
        ...entries.map(({ minorId }) => minorId),
        ...(additionalResponsibleId ? [additionalResponsibleId] : []),
      ].sort(),
      items: planItems,
    });
  }
  plans.sort((left, right) => left.householdId.localeCompare(right.householdId));

  const validProfiles = [...profiles.values()];
  classifications.closingAccounts = closingAccountIds.size;
  const totals = {
    profiles: validProfiles.length,
    adults: validProfiles.filter(({ accountType }) => accountType === 'adult').length,
    minors: validProfiles.filter(({ accountType }) => accountType === 'minor').length,
    legacyLinks,
    validLegacyLinks,
    households: plans.length,
  };
  const stablePlans = plans.map(({ disposition: _disposition, ...plan }) => plan);
  const planHash = sha256(canonicalJson(stablePlans));
  return { schemaVersion: 1, totals, classifications, plans, planHash };
}

function validateRunOptions(options) {
  const { operation, stage, accountId, tableName, auditTableName, apply, ddb } = options;
  if (!OPERATIONS.has(operation)) {
    throw new Error('operation must be inventory, backfill, or reconcile');
  }
  if (!STAGES.has(stage)) throw new Error('stage must be dev, test, or prod');
  if (accountId !== PRODUCTION_ACCOUNT_ID) {
    throw new Error(`AWS account must be ${PRODUCTION_ACCOUNT_ID}`);
  }
  if (tableName !== `roadmap-${stage}`) {
    throw new Error('primary table must exactly match the selected stage');
  }
  if (auditTableName !== `roadmap-access-audit-${stage}`) {
    throw new Error('audit table must exactly match the selected stage');
  }
  if (apply && operation !== 'backfill') {
    throw new Error('only backfill supports --apply');
  }
  if (!ddb || typeof ddb.send !== 'function') throw new Error('ddb is required');
}

async function scanFamilyModel(ddb, tableName) {
  const items = [];
  const scan = { pages: 0, scannedItems: 0, returnedItems: 0 };
  let cursor;
  do {
    const response = await ddb.send(
      new ScanCommand({
        TableName: tableName,
        ConsistentRead: true,
        Select: 'SPECIFIC_ATTRIBUTES',
        ProjectionExpression: SAFE_PROJECTION,
        ExpressionAttributeNames: SAFE_NAMES,
        ...(cursor ? { ExclusiveStartKey: cursor } : {}),
      }),
    );
    const pageItems = Array.isArray(response.Items) ? response.Items : [];
    items.push(...pageItems);
    scan.pages += 1;
    scan.scannedItems += Number.isSafeInteger(response.ScannedCount)
      ? response.ScannedCount
      : pageItems.length;
    scan.returnedItems += pageItems.length;
    cursor = response.LastEvaluatedKey;
  } while (cursor);
  return { items, scan };
}

function buildManifest({ operation, apply, stage, accountId, tableName, auditTableName, scan, result }) {
  const candidates = result.plans.filter(({ disposition }) => disposition === 'candidate');
  const manifest = {
    schemaVersion: 1,
    operation,
    mode: apply ? 'apply' : 'dry-run',
    stage,
    accountId,
    resources: { primaryTable: tableName, auditTable: auditTableName },
    scan,
    totals: result.totals,
    classifications: result.classifications,
    backfill: {
      candidateHouseholds: candidates.length,
      wouldWriteItems: candidates.reduce((total, plan) => total + plan.items.length + 1, 0),
      appliedHouseholds: 0,
      alreadyAppliedHouseholds: result.classifications.alreadyBackfilled,
      conflictedHouseholds: 0,
    },
    safety: {
      deletes: 0,
      coverageWrites: 0,
      flagWrites: 0,
      legacyLinksPreserved: true,
      rollback: 'family flags remain independently reversible',
    },
    planHash: result.planHash,
    writes: 0,
  };
  return { ...manifest, manifestHash: sha256(canonicalJson(manifest)) };
}

function hasExactKeys(value, keys) {
  return (
    isObject(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function isCounter(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function validateFamilyModelManifest(
  manifest,
  { operation, stage, accountId, mode } = {},
) {
  const topKeys = [
    'schemaVersion',
    'operation',
    'mode',
    'stage',
    'accountId',
    'resources',
    'scan',
    'totals',
    'classifications',
    'backfill',
    'safety',
    'planHash',
    'writes',
    'manifestHash',
  ];
  const totalKeys = [
    'profiles',
    'adults',
    'minors',
    'legacyLinks',
    'validLegacyLinks',
    'households',
  ];
  const classificationKeys = [
    'eligible',
    'alreadyBackfilled',
    'legacyOverCapacity',
    'ambiguousHouseholds',
    'minorsWithoutCreatedGuardian',
    'invalidLinks',
    'orphanedLinks',
    'existingDrift',
    'closingAccounts',
    'closingHouseholds',
    'emptyAdultHouseholds',
    'invalidProfiles',
  ];
  const backfillKeys = [
    'candidateHouseholds',
    'wouldWriteItems',
    'appliedHouseholds',
    'alreadyAppliedHouseholds',
    'conflictedHouseholds',
  ];
  if (
    !hasExactKeys(manifest, topKeys) ||
    manifest.schemaVersion !== 1 ||
    manifest.operation !== operation ||
    manifest.mode !== mode ||
    manifest.stage !== stage ||
    manifest.accountId !== accountId ||
    !hasExactKeys(manifest.resources, ['primaryTable', 'auditTable']) ||
    manifest.resources.primaryTable !== `roadmap-${stage}` ||
    manifest.resources.auditTable !== `roadmap-access-audit-${stage}` ||
    !hasExactKeys(manifest.scan, ['pages', 'scannedItems', 'returnedItems']) ||
    !Object.values(manifest.scan).every(isCounter) ||
    !hasExactKeys(manifest.totals, totalKeys) ||
    !Object.values(manifest.totals).every(isCounter) ||
    !hasExactKeys(manifest.classifications, classificationKeys) ||
    !Object.values(manifest.classifications).every(isCounter) ||
    !hasExactKeys(manifest.backfill, backfillKeys) ||
    !Object.values(manifest.backfill).every(isCounter) ||
    !hasExactKeys(manifest.safety, [
      'deletes',
      'coverageWrites',
      'flagWrites',
      'legacyLinksPreserved',
      'rollback',
    ]) ||
    manifest.safety.deletes !== 0 ||
    manifest.safety.coverageWrites !== 0 ||
    manifest.safety.flagWrites !== 0 ||
    manifest.safety.legacyLinksPreserved !== true ||
    manifest.safety.rollback !== 'family flags remain independently reversible' ||
    !/^[a-f0-9]{64}$/.test(manifest.planHash) ||
    !/^[a-f0-9]{64}$/.test(manifest.manifestHash) ||
    !isCounter(manifest.writes)
  ) {
    throw new Error('migration returned an invalid sanitized manifest');
  }
  const { totals, classifications, backfill, scan } = manifest;
  if (
    totals.adults + totals.minors !== totals.profiles ||
    totals.households !== totals.adults ||
    totals.validLegacyLinks > totals.legacyLinks ||
    classifications.legacyOverCapacity > totals.households ||
    classifications.emptyAdultHouseholds > totals.adults ||
    classifications.eligible +
        classifications.alreadyBackfilled +
        classifications.ambiguousHouseholds +
        classifications.existingDrift +
        classifications.closingHouseholds !==
      totals.households ||
    backfill.candidateHouseholds !== classifications.eligible ||
    backfill.alreadyAppliedHouseholds !== classifications.alreadyBackfilled ||
    backfill.wouldWriteItems < backfill.candidateHouseholds ||
    backfill.appliedHouseholds + backfill.conflictedHouseholds >
      backfill.candidateHouseholds ||
    scan.returnedItems > scan.scannedItems ||
    manifest.writes !== backfill.appliedHouseholds ||
    (mode === 'dry-run' &&
      (manifest.writes !== 0 ||
        backfill.appliedHouseholds !== 0 ||
        backfill.conflictedHouseholds !== 0)) ||
    (mode === 'apply' && operation !== 'backfill')
  ) {
    throw new Error('migration returned inconsistent aggregate totals');
  }
  const { manifestHash, ...contents } = manifest;
  if (sha256(canonicalJson(contents)) !== manifestHash) {
    throw new Error('manifest hash does not match its contents');
  }
  return manifest;
}

function exactProfileCheck(tableName, accountId, accountType) {
  return {
    ConditionCheck: {
      TableName: tableName,
      Key: { pk: `USER#${accountId}`, sk: 'PROFILE' },
      ConditionExpression: [
        'attribute_exists(pk)',
        'userId = :accountId',
        'accountType = :accountType',
        '(attribute_not_exists(#status) OR #status = :active)',
      ].join(' AND '),
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':accountId': accountId,
        ':accountType': accountType,
        ':active': 'active',
      },
    },
  };
}

function exactLegacyLinkCheck(tableName, link) {
  return {
    ConditionCheck: {
      TableName: tableName,
      Key: { pk: link.pk, sk: link.sk },
      ConditionExpression: [
        'attribute_exists(pk)',
        '#kind = :kind',
        'guardianId = :guardianId',
        'minorId = :minorId',
        'linkId = :linkId',
        'createdAt = :createdAt',
        'gsi1pk = :gsi1pk',
        'gsi1sk = :gsi1sk',
      ].join(' AND '),
      ExpressionAttributeNames: { '#kind': 'kind' },
      ExpressionAttributeValues: {
        ':kind': link.kind,
        ':guardianId': link.guardianId,
        ':minorId': link.minorId,
        ':linkId': link.linkId,
        ':createdAt': link.createdAt,
        ':gsi1pk': link.gsi1pk,
        ':gsi1sk': link.gsi1sk,
      },
    },
  };
}

function closureAbsentCheck(tableName, accountId) {
  return {
    ConditionCheck: {
      TableName: tableName,
      Key: { pk: `ACCOUNT_CLOSURE#${accountId}`, sk: 'STATE' },
      ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
    },
  };
}

function migrationAuditPut({ auditTableName, stage, plan, planHash, migrationStartedAt }) {
  const targetId = sha256(`household\0${plan.householdId}`);
  const requestId = `family-model-v2-${sha256(`${planHash}\0${plan.householdId}`).slice(0, 16)}`;
  return {
    Put: {
      TableName: auditTableName,
      Item: {
        pk: `TARGET#FAMILY_MODEL#${targetId}`,
        sk: `EVENT#${migrationStartedAt}#${requestId}`,
        entityType: 'AuditEvent',
        targetKind: 'FAMILY_MODEL',
        targetId,
        timestamp: migrationStartedAt,
        requestId,
        action: 'family_model_backfill_v2',
        actor: 'commercial-migration',
        subject: sha256(`subject\0${plan.primaryResponsibleId}`),
        details: {
          stage,
          state: plan.state,
          minorCount: plan.minorIds.length,
          additionalScopeCount: plan.additionalScope.length,
          sourceCreatedAt: plan.items[0].createdAt,
        },
      },
      ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
    },
  };
}

export function buildFamilyModelBackfillTransaction({
  tableName,
  auditTableName,
  stage,
  plan,
  planHash,
  migrationStartedAt,
}) {
  if (!isObject(plan) || plan.disposition !== 'candidate') {
    throw new Error('backfill transaction requires a candidate plan');
  }
  if (!isTimestamp(migrationStartedAt)) {
    throw new Error('migrationStartedAt must be a non-negative safe integer');
  }
  const overCapacity = plan.state === 'legacy_over_capacity';
  // Three exact created links are sufficient to prove that the fixed two-seat
  // model is exceeded. Capping the witness keeps even pathological legacy
  // households within DynamoDB's 100-operation transaction limit.
  const guardedSourceLinks = overCapacity ? plan.sourceLinks.slice(0, 3) : plan.sourceLinks;
  const guardedMinorIds = overCapacity
    ? [...new Set(guardedSourceLinks.map(({ minorId }) => minorId))]
    : plan.minorIds;
  const accountChecks = [
    exactProfileCheck(tableName, plan.primaryResponsibleId, 'adult'),
    ...guardedMinorIds.map((minorId) => exactProfileCheck(tableName, minorId, 'minor')),
    ...(!overCapacity && plan.additionalResponsibleId
      ? [exactProfileCheck(tableName, plan.additionalResponsibleId, 'adult')]
      : []),
  ];
  const guardedAccountIds = [
    plan.primaryResponsibleId,
    ...guardedMinorIds,
    ...(!overCapacity && plan.additionalResponsibleId
      ? [plan.additionalResponsibleId]
      : []),
  ];
  const closureChecks = [...new Set(guardedAccountIds)].map((accountId) =>
    closureAbsentCheck(tableName, accountId),
  );
  const sourceChecks = guardedSourceLinks.map((link) => exactLegacyLinkCheck(tableName, link));
  const itemPuts = plan.items.map((item) => ({
    Put: {
      TableName: tableName,
      Item: item,
      ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
      ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
    },
  }));
  const TransactItems = [
    ...accountChecks,
    ...sourceChecks,
    ...closureChecks,
    ...itemPuts,
    migrationAuditPut({ auditTableName, stage, plan, planHash, migrationStartedAt }),
  ];
  if (TransactItems.length > 100) {
    throw new Error('family model transaction exceeds the DynamoDB limit');
  }
  return {
    TransactItems,
    ClientRequestToken: `fmv2-${sha256(`${planHash}\0${plan.householdId}`).slice(0, 31)}`,
  };
}

function checkpointFor(options, planHash, nextIndex, totalPlans, migrationStartedAt) {
  const checkpoint = {
    schemaVersion: 1,
    operation: 'backfill',
    stage: options.stage,
    accountId: options.accountId,
    tableName: options.tableName,
    auditTableName: options.auditTableName,
    planHash,
    migrationStartedAt,
    nextIndex,
    complete: nextIndex === totalPlans,
  };
  return { ...checkpoint, checkpointHash: sha256(canonicalJson(checkpoint)) };
}

function validateCheckpoint(checkpoint, options, planHash, totalPlans) {
  if (checkpoint === null || checkpoint === undefined) {
    return { nextIndex: 0, migrationStartedAt: null };
  }
  if (!isObject(checkpoint)) throw new Error('checkpoint must be an object');
  const expectedKeys = [
    'schemaVersion',
    'operation',
    'stage',
    'accountId',
    'tableName',
    'auditTableName',
    'planHash',
    'migrationStartedAt',
    'nextIndex',
    'complete',
    'checkpointHash',
  ];
  if (
    Object.keys(checkpoint).length !== expectedKeys.length ||
    expectedKeys.some((key) => !Object.prototype.hasOwnProperty.call(checkpoint, key))
  ) {
    throw new Error('checkpoint shape is invalid');
  }
  for (const [field, expected] of [
    ['schemaVersion', 1],
    ['operation', 'backfill'],
    ['stage', options.stage],
    ['accountId', options.accountId],
    ['tableName', options.tableName],
    ['auditTableName', options.auditTableName],
    ['planHash', planHash],
  ]) {
    if (checkpoint[field] !== expected) throw new Error(`checkpoint ${field} does not match this run`);
  }
  if (
    !Number.isSafeInteger(checkpoint.nextIndex) ||
    checkpoint.nextIndex < 0 ||
    checkpoint.nextIndex > totalPlans ||
    !isTimestamp(checkpoint.migrationStartedAt) ||
    checkpoint.complete !== (checkpoint.nextIndex === totalPlans)
  ) {
    throw new Error('checkpoint position is invalid');
  }
  const { checkpointHash, ...contents } = checkpoint;
  if (!/^[a-f0-9]{64}$/.test(checkpointHash) || sha256(canonicalJson(contents)) !== checkpointHash) {
    throw new Error('checkpoint hash does not match its contents');
  }
  return {
    nextIndex: checkpoint.nextIndex,
    migrationStartedAt: checkpoint.migrationStartedAt,
  };
}

function rehashManifest(manifest) {
  const { manifestHash: _oldHash, ...contents } = manifest;
  return { ...contents, manifestHash: sha256(canonicalJson(contents)) };
}

function isConditionalFailure(error) {
  return Boolean(
    error &&
      typeof error === 'object' &&
      (error.name === 'TransactionCanceledException' ||
        error.name === 'ConditionalCheckFailedException'),
  );
}

export async function runFamilyModelMigration(options = {}) {
  const normalized = {
    operation: options.operation ?? 'inventory',
    apply: options.apply ?? false,
    stage: options.stage,
    accountId: options.accountId,
    tableName: options.tableName,
    auditTableName: options.auditTableName,
    ddb: options.ddb,
  };
  validateRunOptions(normalized);
  const { items, scan } = await scanFamilyModel(normalized.ddb, normalized.tableName);
  const result = classifyLegacyFamilyModel(items);
  const preview = buildManifest({ ...normalized, apply: false, scan, result });
  if (!normalized.apply) return preview;
  if (!/^[a-f0-9]{64}$/.test(options.expectedManifestHash ?? '')) {
    throw new Error('apply requires a lowercase SHA-256 expected manifest hash');
  }
  if (options.expectedManifestHash !== preview.manifestHash) {
    throw new Error('current dry-run manifest does not match the confirmed hash');
  }
  const loadCheckpoint = options.loadCheckpoint ?? (async () => null);
  const saveCheckpoint = options.saveCheckpoint;
  if (typeof loadCheckpoint !== 'function' || typeof saveCheckpoint !== 'function') {
    throw new Error('apply requires checkpoint load and save functions');
  }
  const checkpointState = validateCheckpoint(
    await loadCheckpoint(),
    normalized,
    result.planHash,
    result.plans.length,
  );
  const now = options.now ?? Date.now;
  if (typeof now !== 'function') throw new Error('now must be a function');
  const migrationStartedAt = checkpointState.migrationStartedAt ?? now();
  if (!isTimestamp(migrationStartedAt)) {
    throw new Error('migration clock must return a non-negative safe integer');
  }
  let manifest = buildManifest({ ...normalized, apply: true, scan, result });
  for (let index = checkpointState.nextIndex; index < result.plans.length; index += 1) {
    const plan = result.plans[index];
    if (plan.disposition === 'candidate') {
      try {
        await normalized.ddb.send(
          new TransactWriteCommand(
            buildFamilyModelBackfillTransaction({
              tableName: normalized.tableName,
              auditTableName: normalized.auditTableName,
              stage: normalized.stage,
              plan,
              planHash: result.planHash,
              migrationStartedAt,
            }),
          ),
        );
        manifest.backfill.appliedHouseholds += 1;
        manifest.writes += 1;
      } catch (error) {
        if (!isConditionalFailure(error)) throw error;
        manifest.backfill.conflictedHouseholds += 1;
      }
    }
    await saveCheckpoint(
      checkpointFor(
        normalized,
        result.planHash,
        index + 1,
        result.plans.length,
        migrationStartedAt,
      ),
    );
  }
  if (result.plans.length === 0) {
    await saveCheckpoint(checkpointFor(normalized, result.planHash, 0, 0, migrationStartedAt));
  }
  manifest = rehashManifest(manifest);
  return manifest;
}
