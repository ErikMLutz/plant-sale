configuration = {
    "global": {
        "fuzzy_match_threshold": 95,
    },
    "plants": {
        "title": "{scientific_name} ({common_name})",
        "tags": {
            "valid": [
                "rain garden",
                "pollinator",
                "deer",
                "native",
                "sun",
                "part-shade",
                "shade",
                "drought",
                "groundcover",
                "reg water",
                "tree",
                "shrub",
                ],
            "exclude": [
            ],
            "replace": {},
            "exceptions": {
                "full shade": "shade",
                "drought tolerant": "drought",
                "part sun": "part-shade",
            },
        },
    },
    "veggies": {
        "title": "{common_name}",
        "tags": {
            "valid": [
                "sun",
                "part-shade",
                "shade",
                "drought",
                "rain garden",
                "pollinator",
                "reg water",
                "deer",
                "native",
                "herb",
                "veggie",
                ],
            "exclude": [
            ],
            "replace": {},
            "exceptions": {},
        },
    },
    "houseplants": {
        "title": "{common_name} ({scientific_name})",
        "tags": {
            "valid": [
                "sun",
                "part-shade",
                "shade",
                "drought",
                "rain garden",
                "pollinator",
                "deer",
                "native",
                "reg water",
                "houseplant",
                "bright light",
                "indirect light",
                "herb",
                ],
            "exclude": [
            ],
            "replace": {
                "sun": "bright light",
                "shade": "indirect light",
                "part-shade": "indirect light",
            },
            "exceptions": {
                "bright direct light": "bright light",
                "full sun if outside": "bright light",
                "low light": "indirect light",
                "full shade": "indirect light",
            },
        },
    },
}
