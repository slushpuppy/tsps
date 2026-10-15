// Run after `yarn build`: node --test tests/item-requirements.test.cjs
// Equipment requirements only live in the item-gameplay.json export, and ItemDefinitionLoader
// skips an entry whose name differs from the cache's (ignoring case) - so a cache rename drops
// the entry's requirements along with everything else in it. docs/cache-revision-update.md owns
// the refresh rule; this test is the guard.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { Server } = require("../dist/Server");
Server.installProductionPathResolver();
const { CachePipeline } = require("../dist/game/cache/CachePipeline");
CachePipeline.initialize();
const { ItemDefinition } = require("../dist/game/definition/ItemDefinition");
const { CacheDefinitions } = require("../dist/game/cache/CacheDefinitions");
const { Skill } = require("../dist/game/model/Skill");
const { EquipmentRequirements } = require("../dist/game/model/equipment/EquipmentRequirements");
require("../plugins/items/ItemDefinitionLoader.plugin").register({ log() {}, onPlayerLogin() {}, registerContentEndpoint() {} });

/** The six gods' blessed d'hide bodies, chaps, coifs, bracers and boots. */
const BLESSED_DHIDE = [
  10368, 10370, 10372, 10374, 10376, 10378, 10380, 10382, 10384, 10386, 10388, 10390,
  12490, 12492, 12494, 12496, 12498, 12500, 12502, 12504, 12506, 12508, 12510, 12512,
  19921, 19924, 19927, 19930, 19933, 19936,
];

const wearer = (levels) => ({
  getSkillManager: () => ({
    getMaxLevel: (skill) => levels[skill.getName().toLowerCase()] ?? 1,
    getCombatLevel: () => 3,
  }),
});
const ANY_LEVEL = wearer({});

test("every blessed d'hide piece asks for 40 Defence and 70 Ranged", () => {
  const defence = Skill.DEFENCE.getIndex();
  const ranged = Skill.RANGED.getIndex();
  const wrong = BLESSED_DHIDE.filter((id) => {
    const requirements = ItemDefinition.forId(id).getRequirements();
    return requirements[defence] !== 40 || requirements[ranged] !== 70;
  }).map((id) => `${id} ${CacheDefinitions.getItem(id).name}`);
  assert.deepEqual(wrong, []);
});

test("a low level player is refused a blessed d'hide body", () => {
  // 10370 was exported as "Zamorak d'hide" and the cache renamed it to "Zamorak d'hide body",
  // which used to drop the whole entry: the body wore with no requirement at all.
  assert.deepEqual(
    EquipmentRequirements.getUnmet(ANY_LEVEL, ItemDefinition.forId(10370)),
    { label: "Defence", level: 40 }
  );
  assert.equal(
    EquipmentRequirements.message({ label: "Defence", level: 40 }),
    "You need a Defence level of at least 40 to wear this."
  );
  assert.equal(
    EquipmentRequirements.getUnmet(wearer({ defence: 40 }), ItemDefinition.forId(10370)).label,
    "Ranged",
    "the body then asks for Ranged too"
  );
  assert.equal(EquipmentRequirements.getUnmet(
    wearer({ defence: 40, ranged: 70 }),
    ItemDefinition.forId(10370)
  ), null, "and wears once both are met");
});

test("no blessed d'hide entry is skipped for its name", () => {
  const rows = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../data/definitions/item-gameplay.json"), "utf8")
  );
  const byId = new Map(rows.map((row) => [row.id, row]));
  const skipped = BLESSED_DHIDE.filter((id) => {
    const row = byId.get(id);
    return (row?.name || "").trim().toLowerCase() !== CacheDefinitions.getItem(id).name.trim().toLowerCase();
  });
  assert.deepEqual(skipped, []);
});

test("the export's other dropped requirement rows are the known list", () => {
  // Each of these is a cache rename, a removed item (the two Null ids), or needs its levels
  // checked by hand; fix one by deleting it here. New ids failing means a cache rename ate a
  // requirement.
  const KNOWN = [
    2535, 2537, 2539, 2541, 11222, 21330, // fire arrows: the export keys the lit arrow's id
    10079, 10081, 10085, // "spiky vambs" -> "spiky vambraces"
    10798, 10800, // rune platebody (g)/(t): Null in the cache
    10826, // "Fremennik shield" -> "Neitiznot shield"
    13337, 13338, // "Ava's max cape/hood" -> "Accumulator max cape/hood"
    13381, // "Shayzien platebody (5)" -> "Shayzien body (5)"
  ].sort((a, b) => a - b);
  const rows = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../data/definitions/item-gameplay.json"), "utf8")
  );
  const dropped = rows
    .filter((row) => Array.isArray(row.requirements) && row.requirements.some((level) => level > 0))
    .filter((row) => {
      const cached = CacheDefinitions.getItem(row.id);
      return (row.name || "").trim().toLowerCase() !== (cached?.name ?? "").trim().toLowerCase();
    })
    .map((row) => row.id)
    .sort((a, b) => a - b);
  assert.deepEqual(dropped, KNOWN);
});
