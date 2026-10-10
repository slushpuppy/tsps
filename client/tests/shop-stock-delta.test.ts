/**
 * Regression test: a shop stock update patches only the slots that moved.
 *
 * The server used to reopen the whole shop on every purchase. That remounted
 * both sub-interfaces - WidgetManager.openSubInterface closes the target before
 * it opens it, and each side calls invalidateAll - re-ran the shop scripts and
 * rewrote all 300 slot flags, which is what made a slow client fall further
 * behind with every click. It now sends a SHOP_SLOT patch per changed slot.
 *
 * This side has to honour that. handleShopServerUpdate is handed the whole shop
 * state on every packet, so it used to clear the 300-slot container and
 * repopulate it from scratch; that rewrote every slot for a one-slot change and
 * re-rendered every item icon. It must now write only the slots that differ,
 * and still clear the ones the server stopped listing.
 */
import assert from "node:assert/strict";

// ── Browser-global + asset shims so the OsrsClient module graph loads under node/tsx ──
const g = globalThis as any;
g.self = g;
g.window = g;
const sheet = {
    cssRules: [],
    rules: [],
    insertRule: (r: any) => {
        this.cssRules.push(r);
        return 0;
    },
    deleteRule() {},
    addRule() {},
    removeRule() {},
};
const mkEl = () => ({
    style: {},
    children: [],
    nodeType: 1,
    tagName: "DIV",
    setAttribute() {},
    removeAttribute() {},
    appendChild(c: any) {
        this.children.push(c);
        return c;
    },
    removeChild() {},
    addEventListener() {},
    removeEventListener() {},
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0 }),
    classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
});
const head = mkEl();
head.styleSheets = [sheet];
g.document = g.document ?? {
    elementFromPoint: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    removeEventListener: () => {},
    createElement: mkEl,
    createElementNS: mkEl,
    body: mkEl(),
    head,
    documentElement: mkEl(),
    createTextNode: () => ({}),
};
if (!g.WebSocket)
    g.WebSocket = class {
        static OPEN = 1;
        constructor() {}
        close() {}
        send() {}
    };
const ext = require("module")._extensions;
for (const e of [
    ".glsl", ".css", ".png", ".jpg", ".jpeg", ".webp", ".gif",
    ".svg", ".mp3", ".ogg", ".wav", ".json", ".bin", ".dat",
])
    ext[e] = (m: any) => {
        m.exports = "";
    };
for (const name of ["leva", "@stitches/react", "usehooks-ts", "react", "react-dom"]) {
    try {
        const p = require.resolve(name);
        require.cache[p] = {
            id: p,
            filename: p,
            loaded: true,
            paths: [],
            exports: new Proxy(
                {},
                {
                    get: (_t, k: string) =>
                        k === "__esModule" ? false : k === "default" ? {} : () => ({}),
                },
            ),
        };
    } catch {}
}

// The shims above must be in place before the OsrsClient module graph loads
// (it touches browser globals at import time). Load synchronously via require.
const { OsrsClient } = require("../game/OsrsClient");
const { Inventory } = require("../rs/inventory/Inventory");
const { getTransmitCycles } = require("../game/TransmitCycles");

const CAPACITY = 300;
const SHOP_INV = 516;
const BRONZE_AXE = 1351;
const STEEL_AXE = 1353;

type Slot = [slot: number, itemId: number, quantity: number];

/** A stand-in for the client: only what handleShopServerUpdate touches. */
function createSelf() {
    const self: any = { shopInventory: new Inventory(CAPACITY) };
    const ops: string[] = [];
    const setSlot = self.shopInventory.setSlot.bind(self.shopInventory);
    const setSnapshot = self.shopInventory.setSnapshot.bind(self.shopInventory);
    self.shopInventory.setSlot = (index: number, itemId: number, quantity: number) => {
        ops.push(`setSlot ${index}`);
        return setSlot(index, itemId, quantity);
    };
    self.shopInventory.setSnapshot = (entries: any[], opts?: any) => {
        ops.push(`setSnapshot ${entries.length}`);
        return setSnapshot(entries, opts);
    };
    /** Applies one server update and returns the container writes it caused. */
    self.apply = (state: any): string[] => {
        ops.length = 0;
        OsrsClient.prototype.handleShopServerUpdate.call(self, state);
        return ops.slice();
    };
    self.occupied = (): Slot[] =>
        self.shopInventory
            .getSlots()
            .filter((slot: any) => slot.itemId > 0)
            .map((slot: any) => [slot.slot, slot.itemId, slot.quantity]);
    return self;
}

const shopState = (...slots: Slot[]) => ({
    open: true,
    shopId: "900",
    name: "Bob's Brilliant Axes",
    stock: slots.map(([slot, itemId, quantity]) => ({ slot, itemId, quantity })),
});

const invTransmitAt = (index: number) => getTransmitCycles().changedInvsBuffer[index & 31];

// ── Test 1 (the fix): a one-slot stock change writes that slot alone ──
{
    const self = createSelf();
    self.apply(shopState([0, BRONZE_AXE, 2], [1, STEEL_AXE, 1]));

    // The server patches slot 0 after a purchase; slot 1 is untouched.
    const ops = self.apply(shopState([0, BRONZE_AXE, 1], [1, STEEL_AXE, 1]));

    assert.deepEqual(ops, ["setSlot 0"], "the other 299 slots must not be rewritten");
    assert.deepEqual(self.occupied(), [[0, BRONZE_AXE, 1], [1, STEEL_AXE, 1]]);
}
console.log("shop delta test 1 passed: a one-slot patch writes one slot, no clear-and-repopulate");

// ── Test 2: an unchanged re-send writes nothing at all ──
{
    const self = createSelf();
    self.apply(shopState([0, BRONZE_AXE, 2], [1, STEEL_AXE, 1]));

    const ops = self.apply(shopState([0, BRONZE_AXE, 2], [1, STEEL_AXE, 1]));

    assert.deepEqual(ops, [], "re-applying identical stock must be a no-op");
    assert.deepEqual(self.occupied(), [[0, BRONZE_AXE, 2], [1, STEEL_AXE, 1]]);
}
console.log("shop delta test 2 passed: re-applying identical stock is a true no-op");

// ── Test 3: a slot the server stopped listing is cleared ──
// A sold-in item leaves the display when it runs out, so the stock simply gets
// shorter; nothing names the vacated slot, and a stale item there would be
// clickable.
{
    const self = createSelf();
    self.apply(shopState([0, BRONZE_AXE, 3], [1, STEEL_AXE, 1]));

    const ops = self.apply(shopState([0, BRONZE_AXE, 3]));

    assert.deepEqual(ops, ["setSlot 1"], "only the vacated slot is written");
    assert.deepEqual(self.occupied(), [[0, BRONZE_AXE, 3]]);
    assert.equal(self.shopInventory.getSlot(1).itemId, -1);
}
console.log("shop delta test 3 passed: stock leaving the display clears its slot");

// ── Test 4: slots shifting down a place are all rewritten ──
{
    const self = createSelf();
    self.apply(shopState([0, BRONZE_AXE, 3], [1, STEEL_AXE, 2]));

    const ops = self.apply(shopState([0, STEEL_AXE, 2], [1, BRONZE_AXE, 3]));

    assert.deepEqual(ops, ["setSlot 0", "setSlot 1"]);
    assert.deepEqual(self.occupied(), [[0, STEEL_AXE, 2], [1, BRONZE_AXE, 3]]);
}
console.log("shop delta test 4 passed: a reshuffle rewrites exactly the moved slots");

// ── Test 5: the shop grid still hears about every open update ──
// The cache script that lays out the grid listens for inventory 516; skipping
// the transmit would leave the drawn quantities behind the container.
{
    const self = createSelf();
    const before = getTransmitCycles().changedInvCount;

    self.apply(shopState([0, BRONZE_AXE, 2]));
    self.apply(shopState([0, BRONZE_AXE, 2])); // no writes, but still an update

    const cycles = getTransmitCycles();
    assert.equal(cycles.changedInvCount, before + 2, "each update marks one inventory transmit");
    assert.equal(invTransmitAt(before), SHOP_INV);
    assert.equal(invTransmitAt(before + 1), SHOP_INV);
}
console.log("shop delta test 5 passed: inventory 516 transmit still fires when nothing changed");

// ── Test 6: closing empties the container ──
{
    const self = createSelf();
    self.apply(shopState([0, BRONZE_AXE, 2], [1, STEEL_AXE, 1]));

    self.apply({ open: false, stock: [] });

    assert.deepEqual(self.occupied(), []);
}
console.log("shop delta test 6 passed: closing the shop empties the container");

console.log("All shop stock delta regression tests passed");
