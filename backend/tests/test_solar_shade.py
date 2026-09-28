"""Tests for the solar position and shade model (Tier-1 priority)."""

from __future__ import annotations

from datetime import datetime

from app.core.solar import solar_position
from app.engines.heat.shade import ShadeModel


def test_summer_noon_sun_is_high():
    sp = solar_position(datetime(2026, 6, 21, 12, 45), 22.28, 114.16)
    assert 80 < sp.elevation_deg <= 90
    assert sp.is_daytime


def test_winter_noon_sun_is_much_lower():
    summer = solar_position(datetime(2026, 6, 21, 12, 45), 22.28, 114.16)
    winter = solar_position(datetime(2026, 12, 21, 12, 0), 22.28, 114.16)
    assert winter.elevation_deg < summer.elevation_deg - 30


def test_night_sun_below_horizon():
    sp = solar_position(datetime(2026, 6, 21, 23, 0), 22.28, 114.16)
    assert not sp.is_daytime


def _one_building():
    return [{
        "geometry": {"coordinates": [[
            [114.1600, 22.2800], [114.1604, 22.2800],
            [114.1604, 22.2804], [114.1600, 22.2804],
            [114.1600, 22.2800],
        ]]},
        "properties": {"heightM": 60},
    }]


def test_morning_sun_shades_west_side():
    """Sun in the east (az ~78) -> shadow falls WEST of the building."""
    model = ShadeModel(_one_building())
    shade_west, sun = model.shade_at(22.2802, 114.15990,
                                     datetime(2026, 6, 21, 9, 0))
    shade_east, _ = model.shade_at(22.2802, 114.16055,
                                   datetime(2026, 6, 21, 9, 0))
    assert sun.azimuth_deg < 180  # morning sun in the east
    assert shade_west > 0.5
    assert shade_east == 0.0


def test_afternoon_sun_shades_east_side():
    """Sun in the west (az ~280) -> shadow falls EAST of the building."""
    model = ShadeModel(_one_building())
    shade_east, sun = model.shade_at(22.2802, 114.16055,
                                     datetime(2026, 6, 21, 15, 0))
    shade_west, _ = model.shade_at(22.2802, 114.15990,
                                   datetime(2026, 6, 21, 15, 0))
    assert sun.azimuth_deg > 180
    assert shade_east > 0.5
    assert shade_west == 0.0


def test_tall_building_shades_farther_than_low_one():
    dt = datetime(2026, 6, 21, 15, 0)
    far_point = (22.2802, 114.16120)  # ~74 m east of the building centre
    tall = ShadeModel([dict(_one_building()[0],
                            properties={"heightM": 120})])
    low = ShadeModel([dict(_one_building()[0],
                           properties={"heightM": 15})])
    assert tall.shade_at(*far_point, dt)[0] > low.shade_at(*far_point, dt)[0]
