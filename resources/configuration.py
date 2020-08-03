configuration = {
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
                "tree",
                "shrub",
                ],
            "exclude": [
                "reg water",
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
                "deer",
                "native",
                "herb",
                "veggie",
                ],
            "exclude": [
                "reg water",
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
                "houseplant",
                "bright light",
                "indirect light",
                "herb",
                ],
            "exclude": [
                "reg water",
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
