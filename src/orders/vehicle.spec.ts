import { claimableBy, vehicleClass } from './vehicle';

// Must agree with the database's `vehicle_class` (cartman-mobile
// 20261008000100), or the feed shows orders the claim trigger refuses.
describe('vehicleClass', () => {
  it.each([
    ['tricycle', 'tricycle'],
    ['Tricycle', 'tricycle'],
    ['Honda TMX tricycle', 'tricycle'],
    ['motorcycle', 'motorcycle'],
    ['Honda Click 125i', 'motorcycle'],
    ['Motor', 'motorcycle'],
    ['', 'motorcycle'],
  ])('%p is a %s', (vehicle, cls) => {
    expect(vehicleClass(vehicle)).toBe(cls);
  });

  it('a missing vehicle is a motorcycle', () => {
    expect(vehicleClass(null)).toBe('motorcycle');
    expect(vehicleClass(undefined)).toBe('motorcycle');
  });
});

describe('claimableBy', () => {
  it('any-vehicle orders plus the ones that name this vehicle', () => {
    expect(claimableBy('tricycle')).toEqual({
      OR: [{ required_vehicle: null }, { required_vehicle: 'tricycle' }],
    });
  });
});
