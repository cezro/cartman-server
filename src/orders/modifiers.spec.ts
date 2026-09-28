import { ConflictException } from '@nestjs/common';
import {
  OPTIONS_CHANGED,
  parseMenuModifierGroups,
  resolveSelectedModifiers,
} from './modifiers';

// The store's groups, as the Merchant Panel's ModifierEditor writes them.
const menu = [
  {
    name: 'Size',
    required: true,
    max: 1,
    options: [
      { name: 'Regular', price: 0 },
      { name: 'Large', price: 3000 },
    ],
  },
  {
    name: 'Add-ons',
    required: false,
    max: 2,
    options: [
      { name: 'Extra rice', price: 2500 },
      { name: 'Egg', price: 1500 },
      { name: 'No rice', price: -1000 },
    ],
  },
];

describe('parseMenuModifierGroups (mirrors ModifierGroup.parse in the app)', () => {
  it('reads groups and prices options as bigint centavos', () => {
    const [size] = parseMenuModifierGroups(menu);
    expect(size).toEqual({
      name: 'Size',
      required: true,
      max: 1,
      options: [
        { name: 'Regular', price: 0n },
        { name: 'Large', price: 3000n },
      ],
    });
  });

  it('drops half-finished groups and nameless options, and clamps max', () => {
    const groups = parseMenuModifierGroups([
      { name: '', options: [{ name: 'A', price: 1 }] },
      { name: 'Empty', options: [] },
      { name: 'Sauce', max: 0, options: [{ name: '' }, { name: ' Gravy ' }] },
      { name: 'Sides', max: 9, options: [{ name: 'A' }, { name: 'B' }] },
      'not a group',
    ]);
    expect(groups.map((g) => [g.name, g.max, g.options.length])).toEqual([
      ['Sauce', 1, 1],
      ['Sides', 2, 2],
    ]);
    expect(groups[0].options[0]).toEqual({ name: 'Gravy', price: 0n });
    expect(groups[0].required).toBe(false);
  });

  it('treats anything but an array as no groups', () => {
    expect(parseMenuModifierGroups(null)).toEqual([]);
    expect(parseMenuModifierGroups({})).toEqual([]);
  });
});

describe('resolveSelectedModifiers', () => {
  it('prices each choice from the menu, ignoring the client price', () => {
    const { snapshot, addedPerUnit } = resolveSelectedModifiers(menu, [
      { group: 'Size', name: 'Large', price: 1 },
      { group: 'Add-ons', name: 'Extra rice', price: 0 },
    ]);
    expect(snapshot).toEqual([
      { group: 'Size', name: 'Large', price: 3000 },
      { group: 'Add-ons', name: 'Extra rice', price: 2500 },
    ]);
    expect(addedPerUnit).toBe(5500n);
  });

  it('allows a negative option (a discount for skipping something)', () => {
    const { addedPerUnit } = resolveSelectedModifiers(menu, [
      { group: 'Size', name: 'Regular' },
      { group: 'Add-ons', name: 'No rice' },
    ]);
    expect(addedPerUnit).toBe(-1000n);
  });

  it('returns nothing for a dish with no groups and no choices', () => {
    expect(resolveSelectedModifiers([], undefined)).toEqual({
      snapshot: [],
      addedPerUnit: 0n,
    });
  });

  it.each([
    ['an option the dish no longer has', [{ group: 'Size', name: 'Jumbo' }]],
    ['a group the dish no longer has', [{ group: 'Spice', name: 'Hot' }]],
    [
      'the same option twice',
      [
        { group: 'Size', name: 'Large' },
        { group: 'Add-ons', name: 'Egg' },
        { group: 'Add-ons', name: 'Egg' },
      ],
    ],
    [
      'more options than the group allows',
      [
        { group: 'Size', name: 'Regular' },
        { group: 'Size', name: 'Large' },
      ],
    ],
    ['a required group left unanswered', [{ group: 'Add-ons', name: 'Egg' }]],
    ['no choices on a dish with a required group', undefined],
    ['a malformed entry', ['Large']],
  ])('answers 409 for %s', (_label, requested) => {
    expect(() => resolveSelectedModifiers(menu, requested)).toThrow(
      new ConflictException(OPTIONS_CHANGED),
    );
  });
});
