"""Hong Kong gazetteer: place search for the heat map's location input.

A curated list of MTR stations, piers, peaks, parks and landmarks with
approximate coordinates (SIMULATED accuracy for demo purposes; a real
deployment would use the LandsD / GeoCom gazetteer or CSDI search API through
a provider). Each place maps to the district dataset that covers it, so
searching flies the heat map there and loads that district's modelled data.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from app.data.generate_static_data import DISTRICT_BBOXES

# (name, zh, lat, lon, district_id, kind)
_GAZETTEER: List[tuple] = [
    # -- Hong Kong Island -----------------------------------------------------
    ("Central", "中環", 22.282, 114.158, "central-western", "neighbourhood"),
    ("Sheung Wan", "上環", 22.286, 114.150, "central-western", "neighbourhood"),
    ("Sai Ying Pun", "西營盤", 22.287, 114.142, "central-western", "neighbourhood"),
    ("Kennedy Town", "堅尼地城", 22.286, 114.127, "central-western", "neighbourhood"),
    ("Hong Kong University", "香港大學", 22.283, 114.139, "central-western", "landmark"),
    ("The Peak", "太平山頂", 22.270, 114.150, "central-western", "peak"),
    ("Wan Chai", "灣仔", 22.277, 114.173, "wan-chai", "neighbourhood"),
    ("Causeway Bay", "銅鑼灣", 22.280, 114.185, "wan-chai", "neighbourhood"),
    ("Happy Valley", "跑馬地", 22.267, 114.178, "wan-chai", "neighbourhood"),
    ("Admiralty", "金鐘", 22.279, 114.165, "wan-chai", "neighbourhood"),
    ("North Point", "北角", 22.291, 114.200, "eastern", "neighbourhood"),
    ("Quarry Bay", "鰂魚涌", 22.286, 114.213, "eastern", "neighbourhood"),
    ("Taikoo", "太古", 22.286, 114.221, "eastern", "neighbourhood"),
    ("Shau Kei Wan", "筲箕灣", 22.279, 114.228, "eastern", "neighbourhood"),
    ("Chai Wan", "柴灣", 22.266, 114.242, "eastern", "neighbourhood"),
    ("Aberdeen", "香港仔", 22.247, 114.153, "southern", "neighbourhood"),
    ("Ap Lei Chau", "鴨脷洲", 22.242, 114.155, "southern", "neighbourhood"),
    ("Wong Chuk Hang", "黃竹坑", 22.248, 114.168, "southern", "neighbourhood"),
    ("Repulse Bay", "淺水灣", 22.238, 114.195, "southern", "beach"),
    ("Stanley", "赤柱", 22.219, 114.213, "southern", "neighbourhood"),
    ("Ocean Park", "海洋公園", 22.248, 114.183, "southern", "landmark"),
    # -- Kowloon ----------------------------------------------------------------
    ("Tsim Sha Tsui", "尖沙咀", 22.298, 114.172, "kowloon-yau-tsim", "neighbourhood"),
    ("Jordan", "佐敦", 22.305, 114.171, "kowloon-yau-tsim", "neighbourhood"),
    ("Yau Ma Tei", "油麻地", 22.311, 114.170, "kowloon-yau-tsim", "neighbourhood"),
    ("Mong Kok", "旺角", 22.319, 114.169, "kowloon-yau-tsim", "neighbourhood"),
    ("Kowloon Park", "九龍公園", 22.299, 114.170, "kowloon-yau-tsim", "park"),
    ("West Kowloon Cultural District", "西九文化區", 22.301, 114.160, "kowloon-yau-tsim", "landmark"),
    ("Sham Shui Po", "深水埗", 22.330, 114.155, "kowloon-sham-shui-po", "neighbourhood"),
    ("Cheung Sha Wan", "長沙灣", 22.336, 114.150, "kowloon-sham-shui-po", "neighbourhood"),
    ("Lai Chi Kok", "荔枝角", 22.338, 114.148, "kowloon-sham-shui-po", "neighbourhood"),
    ("Kowloon City", "九龍城", 22.330, 114.191, "kowloon-kowloon-city", "neighbourhood"),
    ("To Kwa Wan", "土瓜灣", 22.318, 114.190, "kowloon-kowloon-city", "neighbourhood"),
    ("Kai Tak", "啟德", 22.324, 114.200, "kowloon-kowloon-city", "neighbourhood"),
    ("Wong Tai Sin", "黃大仙", 22.342, 114.192, "kowloon-wong-tai-sin", "neighbourhood"),
    ("Diamond Hill", "鑽石山", 22.344, 114.205, "kowloon-wong-tai-sin", "neighbourhood"),
    ("Kowloon Peak", "飛鵝山", 22.346, 114.222, "kowloon-wong-tai-sin", "peak"),
    ("Kwun Tong", "觀塘", 22.310, 114.226, "kowloon-kwun-tong", "neighbourhood"),
    ("Ngau Tau Kok", "牛頭角", 22.315, 114.216, "kowloon-kwun-tong", "neighbourhood"),
    ("Yau Tong", "油塘", 22.286, 114.240, "kowloon-kwun-tong", "neighbourhood"),
    ("Lam Tin", "藍田", 22.298, 114.240, "kowloon-kwun-tong", "neighbourhood"),
    ("Kwai Fong", "葵芳", 22.366, 114.128, "kowloon-kwai-tsing", "neighbourhood"),
    ("Kwai Chung", "葵涌", 22.362, 114.130, "kowloon-kwai-tsing", "neighbourhood"),
    ("Tsing Yi", "青衣", 22.358, 114.108, "kowloon-kwai-tsing", "neighbourhood"),
    ("Tsuen Wan", "荃灣", 22.371, 114.120, "kowloon-tsuen-wan", "neighbourhood"),
    ("Sham Tseng", "深井", 22.369, 114.090, "kowloon-tsuen-wan", "neighbourhood"),
    # -- New Territories ----------------------------------------------------------
    ("Tuen Mun", "屯門", 22.394, 113.972, "nt-tuen-mun", "neighbourhood"),
    ("Butterfly Beach", "蝴蝶灣", 22.382, 113.956, "nt-tuen-mun", "beach"),
    ("Yuen Long", "元朗", 22.445, 114.032, "nt-yuen-long", "neighbourhood"),
    ("Tin Shui Wai", "天水圍", 22.461, 114.000, "nt-yuen-long", "neighbourhood"),
    ("Long Ping", "朗屏", 22.447, 114.022, "nt-yuen-long", "neighbourhood"),
    ("Tai Po", "大埔", 22.448, 114.168, "nt-tai-po", "neighbourhood"),
    ("Tai Po Market", "大埔墟", 22.446, 114.170, "nt-tai-po", "neighbourhood"),
    ("Tai Mei Tuk", "大美督", 22.470, 114.220, "nt-tai-po", "landmark"),
    ("Sha Tin", "沙田", 22.381, 114.192, "nt-sha-tin", "neighbourhood"),
    ("Sha Tin Racecourse", "沙田馬場", 22.384, 114.204, "nt-sha-tin", "landmark"),
    ("Ma On Shan", "馬鞍山", 22.402, 114.232, "nt-sha-tin", "neighbourhood"),
    ("Fo Tan", "火炭", 22.390, 114.198, "nt-sha-tin", "neighbourhood"),
    ("Sai Kung Town", "西貢市", 22.382, 114.270, "nt-sai-kung", "neighbourhood"),
    ("Clear Water Bay", "清水灣", 22.298, 114.292, "nt-sai-kung", "beach"),
    ("Tseung Kwan O", "將軍澳", 22.318, 114.258, "nt-sai-kung", "neighbourhood"),
    ("Sheung Shui", "上水", 22.502, 114.130, "nt-north", "neighbourhood"),
    ("Fanling", "粉嶺", 22.492, 114.140, "nt-north", "neighbourhood"),
    ("Tai Po Industrial Estate", "大埔工業邨", 22.468, 114.178, "nt-north", "landmark"),
    ("Tung Chung", "東涌", 22.287, 113.941, "nt-islands", "neighbourhood"),
    ("Hong Kong International Airport", "香港國際機場", 22.308, 113.918, "nt-islands", "landmark"),
    ("Disneyland", "迪士尼樂園", 22.302, 114.047, "nt-islands", "landmark"),
    ("Mui Wo", "梅窩", 22.265, 114.002, "nt-islands", "ferry_pier"),
    # -- Conceptual ---------------------------------------------------------------
    ("Northern Metropolis (conceptual area)", "北部都會區（概念）", 22.515, 114.135,
     "northern-metropolis", "conceptual"),
]


def _district_for(lat: float, lon: float) -> Optional[str]:
    for district_id, (s, w, n, e) in DISTRICT_BBOXES.items():
        if s <= lat <= n and w <= lon <= e:
            return district_id
    return None


def search_places(query: str, limit: int = 8) -> List[Dict[str, Any]]:
    """Case-insensitive prefix/substring search over the gazetteer.

    Returns name, zh, coordinates, covering district and kind. Empty query
    returns the first `limit` places (alphabetical-ish by catalogue order).
    """
    q = query.strip().lower()
    results: List[Dict[str, Any]] = []
    for name, zh, lat, lon, district_id, kind in _GAZETTEER:
        if q and q not in name.lower() and q not in zh:
            continue
        results.append({
            "id": f"geo-{district_id}-{name.lower().replace(' ', '-')[:24]}",
            "name": name,
            "nameZh": zh,
            "location": {"lat": lat, "lon": lon},
            "districtId": district_id,
            "kind": kind,
            "simulatedAccuracy": True,
        })
        if len(results) >= limit:
            break
    return results
