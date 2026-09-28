import { ConflictException } from '@nestjs/common';

/**
 * Dish options ("Size: Large", "Add-ons: Extra rice") on food/grocery orders.
 *
 * The store's questions live in `menu_items.modifiers` as
 * `[{name, required, max, options: [{name, price}]}]`, written by the Merchant
 * Panel's ModifierEditor. The customer app sends what was chosen as
 * `items[].modifiers: [{group, name, price}]`.
 *
 * The client's `price` is never trusted: every choice is resolved against the
 * dish's own groups and priced from the database, the same way `unit_price`
 * already comes from `menu_items.price`. The snapshot written to
 * `order_items.modifiers` carries those database prices, so a later menu edit
 * cannot rewrite what this customer was charged.
 *
 * Parsing mirrors cartman-mobile's `ModifierGroup.parse`
 * (packages/core/lib/src/models/modifiers.dart) so both sides agree on which
 * groups exist: a group with no name or no options is a half-finished panel
 * edit and is ignored, `required` is true only when literally `true`, and
 * `max` defaults to 1 and is clamped to [1, options.length].
 */

export interface MenuModifierOption {
  name: string;
  price: bigint;
}

export interface MenuModifierGroup {
  name: string;
  required: boolean;
  max: number;
  options: MenuModifierOption[];
}

export interface SelectedModifier {
  group: string;
  name: string;
  price: number;
}

/**
 * 409, never 400: the customer app treats any 400 on an order carrying
 * `modifiers` as "this server does not know the key" and retries with the
 * choices stripped, which would place the order without them. A choice that
 * no longer fits the menu means the store edited it while the cart was open,
 * and the customer can fix that by reopening the cart.
 */
export const OPTIONS_CHANGED =
  "This dish's options changed. Open your cart to review them.";

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;

const trimmedName = (v: unknown): string =>
  typeof v === 'string' ? v.trim() : '';

/** Rounds like the app's `(price as num?)?.round() ?? 0`. */
const centavos = (v: unknown): bigint =>
  typeof v === 'number' && Number.isFinite(v)
    ? BigInt(Math.round(v))
    : typeof v === 'string' && /^-?\d+$/.test(v.trim())
      ? BigInt(v.trim())
      : 0n;

/** Reads a dish's `menu_items.modifiers` jsonb, dropping anything unusable. */
export function parseMenuModifierGroups(raw: unknown): MenuModifierGroup[] {
  if (!Array.isArray(raw)) return [];
  const groups: MenuModifierGroup[] = [];
  for (const g of raw) {
    const group = asRecord(g);
    if (!group) continue;
    const name = trimmedName(group.name);
    const options: MenuModifierOption[] = [];
    for (const o of Array.isArray(group.options) ? group.options : []) {
      const option = asRecord(o);
      const optionName = option ? trimmedName(option.name) : '';
      if (!option || !optionName) continue;
      options.push({ name: optionName, price: centavos(option.price) });
    }
    if (!name || options.length === 0) continue;
    const rawMax =
      typeof group.max === 'number' && Number.isFinite(group.max)
        ? Math.round(group.max)
        : 1;
    groups.push({
      name,
      required: group.required === true,
      max: Math.min(Math.max(rawMax, 1), options.length),
      options,
    });
  }
  return groups;
}

/**
 * Resolves the customer's choices for one dish against its groups.
 *
 * Returns the snapshot to store (database names and prices, in the order the
 * customer chose them) and the per-unit sum those choices add. Throws 409 when
 * a choice names a group or option the dish no longer has, repeats an option,
 * exceeds a group's `max`, or leaves a `required` group unanswered.
 */
export function resolveSelectedModifiers(
  menuModifiers: unknown,
  requested: unknown[] | undefined,
): { snapshot: SelectedModifier[]; addedPerUnit: bigint } {
  const groups = parseMenuModifierGroups(menuModifiers);
  const chosen = new Map<MenuModifierGroup, Set<string>>();
  const snapshot: SelectedModifier[] = [];
  let addedPerUnit = 0n;

  for (const entry of requested ?? []) {
    const choice = asRecord(entry);
    const groupName = choice ? trimmedName(choice.group) : '';
    const optionName = choice ? trimmedName(choice.name) : '';
    const group = groups.find((g) => g.name === groupName);
    const option = group?.options.find((o) => o.name === optionName);
    if (!group || !option) throw new ConflictException(OPTIONS_CHANGED);

    const picked = chosen.get(group) ?? new Set<string>();
    if (picked.has(option.name) || picked.size >= group.max) {
      throw new ConflictException(OPTIONS_CHANGED);
    }
    picked.add(option.name);
    chosen.set(group, picked);

    snapshot.push({
      group: group.name,
      name: option.name,
      price: Number(option.price),
    });
    addedPerUnit += option.price;
  }

  for (const group of groups) {
    if (group.required && !chosen.has(group)) {
      throw new ConflictException(OPTIONS_CHANGED);
    }
  }

  return { snapshot, addedPerUnit };
}
