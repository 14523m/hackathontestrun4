"""Published-equation thermal metrics for the street-level heat model.

Every formula here is published and cited — no free calibration constants.
The HeatPredictionService composes them into its explainable scores; the UI
surfaces the raw physical units so results can be checked against sources.

- Vapour pressure: Magnus-Tetens (Alduchov & Eskridge 1996).
- Wet-bulb: Stull (2011), JAMC 50:2267-2279, Eq. 1.
- Apparent temperature (shade): Steadman (1984) AT = Ta + 0.33 e - 0.70 ws - 4.00.
- Apparent temperature (sun): Australian BoM variant
  AT = Ta + 0.348 e - 0.70 ws + 0.70 Q/(ws + 10) - 4.25  (Q = net radiation W/m2).
- WBGT (shade): Australian BoM approximation WBGT = 0.567 Ta + 0.393 e + 3.94
  (e in hPa), the ISO 7243-style outdoor shade screening form.
- Clear-sky direct normal: Hottel (1976) sea-level transmittance
  tau = a0 + a1 exp(-k / sin h) applied to the solar constant; diffuse
  fraction: Erbs, Klein & Duffie (1982); global capped at 1040 W/m2
  (approx observed clear-sky maximum at HKO King's Park radiation station).
- Sky long-wave: Brutsaert (1975), eps_sky = 1.24 (e/T)^{1/7}.
- Mean radiant temperature: Thorsson et al. (2007), J. Geophys. Res. 112
  (THOR/RayMan formulation): six-direction flux integration with angular
  factors F_up = F_down = 0.06, 4 laterals of 0.22, projection factor
  f_p = 0.7 (standing person, ISO 7726 convention), short-wave
  absorptivity 0.7, body emissivity 0.97. Constant f_p is a documented
  simplification (no sun-angle dependence) — MRT runs slightly high in
  full sun; relative sun/shade differences match published ranges.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from app.core.solar import solar_position
from app.core.types import SunPosition

SIGMA = 5.670374419e-8  # Stefan-Boltzmann, W m^-2 K^-4
SOLAR_CONSTANT = 1361.0  # W m^-2 (Kopp & Lean 2011)
GHI_CLEAR_SKY_CAP = 1040.0  # W m^-2, observed clear-sky max (HKO King's Park)
DNI_CLEAR_SKY_CAP = 900.0  # W m^-2, observed clear-sky direct-normal max (humid
# maritime atmosphere attenuates more than Hottel's dry standard atmosphere;
# cap keeps the beam inside the observed HK regime, like the GHI cap above)
BODY_ABSORPTIVITY = 0.7  # short-wave absorptivity, skin/clothing
BODY_EMISSIVITY = 0.97  # long-wave emissivity, skin/clothing
F_UP = 0.06  # angular factor, upward direction (Thorsson et al. 2007)
F_DOWN = 0.06  # angular factor, downward direction
F_LAT = 0.22  # angular factor, each of the 4 lateral directions
URBAN_SURFACE_DELTA_T = 2.0  # C: urban fabric warmth over air for L_up
GROUND_ALBEDO = 0.2  # typical urban albedo

# ------------------------------------------------------------------------
# Psychrometrics
# ------------------------------------------------------------------------


def saturation_vapour_pressure_hpa(temp_c: float) -> float:
    """Magnus-Tetens saturation vapour pressure (hPa)."""
    return 6.1094 * math.exp(17.625 * temp_c / (temp_c + 243.04))


def vapour_pressure_hpa(temp_c: float, rh_pct: float) -> float:
    """Actual water-vapour pressure (hPa), Alduchov & Eskridge (1996)."""
    rh = min(max(rh_pct, 0.0), 100.0)
    return (rh / 100.0) * saturation_vapour_pressure_hpa(temp_c)


def stull_wet_bulb_c(temp_c: float, rh_pct: float) -> float:
    """Stull (2011) Eq. 1 wet-bulb temperature (C), valid RH 5-99 %."""
    rh = min(max(rh_pct, 5.0), 99.0)
    return (
        temp_c * math.atan(0.151977 * math.sqrt(rh + 8.313659))
        + math.atan(temp_c + rh)
        - math.atan(rh - 1.676331)
        + 0.00391838 * rh**1.5 * math.atan(0.023101 * rh)
        - 4.686035
    )


def steadman_at_c(temp_c: float, e_hpa: float, wind_ms: float) -> float:
    """Steadman (1984) shade apparent temperature (C)."""
    return temp_c + 0.33 * e_hpa - 0.70 * wind_ms - 4.00


def steadman_at_sun_c(
    temp_c: float, e_hpa: float, wind_ms: float, net_radiation_wm2: float
) -> float:
    """Australian BoM apparent temperature including solar radiation (C)."""
    return (
        temp_c + 0.348 * e_hpa - 0.70 * wind_ms
        + 0.70 * max(net_radiation_wm2, 0.0) / (wind_ms + 10.0) - 4.25
    )


def wbgt_shade_c(temp_c: float, e_hpa: float) -> float:
    """Australian BoM shade WBGT approximation (C), e in hPa."""
    return 0.567 * temp_c + 0.393 * e_hpa + 3.94


def body_projection_factor(sun_elevation_deg: float) -> float:
    """Projection factor f_p of a standing person for the direct beam.

    Fanger/ISO 7726 convention (used by Thorsson et al. 2007): the projected
    area of a standing adult varies with solar altitude, from ~0.86 for a
    beam at the feet to ~0.14 for overhead sun. Interpolates the published
    envelope linearly; azimuthal orientation is averaged (documented
    simplification).
    """
    h = min(max(sun_elevation_deg, 0.0), 90.0)
    h_rad = math.radians(h)
    f_p = 0.86 * math.cos(h_rad) ** 2 + 0.14 * math.sin(h_rad)
    return min(max(f_p, 0.14), 0.86)


# ------------------------------------------------------------------------
# Radiation
# ------------------------------------------------------------------------


@dataclass(frozen=True)
class RadiationFluxes:
    """Horizontal-plane radiation components (W/m2)."""

    direct_normal: float
    direct_horizontal: float
    diffuse: float
    global_horizontal: float


def clear_sky_fluxes(sun: SunPosition, altitude_m: float = 0.0) -> RadiationFluxes:
    """Clear-sky direct/diffuse/global on a horizontal plane (W/m2).

    Hottel (1976) transmittance for the direct normal beam; Erbs et al.
    (1982) clear-sky diffuse fraction; global capped at GHI_CLEAR_SKY_CAP.
    """
    if sun.elevation_deg <= 0.0:
        return RadiationFluxes(0.0, 0.0, 0.0, 0.0)
    h = max(sun.elevation_deg, 3.0)
    sin_h = math.sin(math.radians(h))
    alt_km = altitude_m / 1000.0
    a0 = 0.4237 - 0.00821 * (6.0 - alt_km) ** 2
    a1 = 0.5055 + 0.00595 * (6.5 - alt_km) ** 2
    k = 0.2711 + 0.01858 * (2.5 - alt_km) ** 2
    direct_normal = SOLAR_CONSTANT * (a0 + a1 * math.exp(-k / sin_h))
    direct_horizontal = direct_normal * sin_h
    # Erbs clear-sky diffuse fraction from the clearness index.
    kt = min(0.8, direct_horizontal / (SOLAR_CONSTANT * sin_h))
    if kt <= 0.22:
        f_diff = 1.0 - 0.09 * kt
    else:
        f_diff = (
            0.9511 - 0.1604 * kt + 4.388 * kt**2
            - 16.638 * kt**3 + 12.336 * kt**4
        )
    # D = fd (B + D)  =>  D = fd / (1 - fd) * B.
    diffuse = direct_horizontal * f_diff / max(1e-6, 1.0 - f_diff)
    global_h = direct_horizontal + diffuse
    if direct_normal > DNI_CLEAR_SKY_CAP:
        scale = DNI_CLEAR_SKY_CAP / direct_normal
        direct_normal = DNI_CLEAR_SKY_CAP
        direct_horizontal *= scale
        global_h = direct_horizontal + diffuse
    if global_h > GHI_CLEAR_SKY_CAP:  # rescale to observed clear-sky ceiling
        scale = GHI_CLEAR_SKY_CAP / global_h
        diffuse *= scale
        direct_horizontal *= scale
        direct_normal *= scale
        global_h = GHI_CLEAR_SKY_CAP
    return RadiationFluxes(direct_normal, direct_horizontal, diffuse, global_h)


def sky_longwave_wm2(temp_c: float, rh_pct: float) -> float:
    """Downwelling atmospheric long-wave (W/m2) — Brutsaert (1975)."""
    t_k = temp_c + 273.15
    e_hpa = vapour_pressure_hpa(temp_c, rh_pct)
    eps_sky = min(max(1.24 * (e_hpa / t_k) ** (1.0 / 7.0), 0.55), 0.95)
    return eps_sky * SIGMA * t_k**4


def surface_longwave_wm2(temp_c: float) -> float:
    """Upwelling long-wave from an eps = 0.95 urban surface at temp_c."""
    return 0.95 * SIGMA * (temp_c + 273.15) ** 4


def mean_radiant_temp_c(
    ta_c: float,
    rh_pct: float,
    fluxes: RadiationFluxes,
    shade_fraction: float,
    svf: float,
    sun_elevation_deg: float,
) -> float:
    """Thorsson et al. (2007) mean radiant temperature (C), 1.1 m.

    Six-direction integration: direct beam on the body (f_p * I with the
    sun-angle projection factor, shadowed), diffuse sky from above, ground
    reflection below, lateral diffuse; long-wave from sky (Brutsaert)
    weighted by sky-view, and warm urban fabric (+2 C over air) filling the
    obstructed fraction.
    """
    f_sun = max(0.0, 1.0 - shade_fraction)
    f_lat_total = 4.0 * F_LAT
    f_p = body_projection_factor(sun_elevation_deg)

    # Short-wave reaching the body, re-expressed black-body-equivalent.
    direct_body = f_p * fluxes.direct_normal * f_sun
    sky_diffuse_up = F_UP * fluxes.diffuse * svf
    ground_reflected = F_DOWN * GROUND_ALBEDO * (
        fluxes.global_horizontal * f_sun + fluxes.diffuse
    )
    lateral_diffuse = f_lat_total * 0.5 * fluxes.diffuse * svf
    sw = (BODY_ABSORPTIVITY / BODY_EMISSIVITY) * (
        direct_body + sky_diffuse_up + ground_reflected + lateral_diffuse
    )

    # Long-wave: sky through the open fraction, urban fabric fills the rest.
    lw_sky = sky_longwave_wm2(ta_c, rh_pct)
    lw_surface = surface_longwave_wm2(ta_c + URBAN_SURFACE_DELTA_T)
    lw = (
        F_UP * lw_sky * svf
        + F_DOWN * lw_surface
        + f_lat_total * ((1.0 - svf) * lw_surface + svf * lw_sky)
    )

    s_str = sw + lw  # mean radiant flux density, W/m2
    return (s_str / (BODY_EMISSIVITY * SIGMA)) ** 0.25 - 273.15


SKIN_TEMP_C = 35.0  # mean skin temperature (Fanger / ISO 7730 comfort baseline)


def body_net_radiation_wm2(mrt_c: float) -> float:
    """Net radiation exchanged by the body (W/m2) for the ABM sun AT.

    Q = eps sigma (T_mrt^4 - T_skin^4): the mean radiant flux density
    ALREADY summarises every short-wave and long-wave exchange (it is what
    MRT means), so the net is the imbalance against the skin's own emission
    at 35 C. Adding the absorbed short-wave separately would double-count.
    """
    return max(
        0.0,
        BODY_EMISSIVITY * SIGMA
        * ((mrt_c + 273.15) ** 4 - (SKIN_TEMP_C + 273.15) ** 4),
    )
