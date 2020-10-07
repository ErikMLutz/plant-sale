import re
import copy
import json


class Configuration:

    def __init__(self):
        self.fuzzy_match_threshold = 95
        self.fuzzy_match_image_metadata_threshold = 75
        self.image_search_folders = {
            "Veggies": "1zrgXvPJl3E7QK70OINvRQq_dbpW_c9VT",
            "Trees and Shrubs": "1rVevYOv3WSjMCC_ZF-qYA5OyK1M3v59U",
            "Perennials": "16zF5McGKenWTNKhf5-5HryaPuf9pF88b",
            "Houseplants": "1NH7ohsDwaDxs0aCZywPw8V6AygAdyCnE",
            "Herbs": "1NaCCovJKdNiaEW5B7AhLmAKNwzCeRrYz",
        }

        self.plants = {
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
                    "veggie",
                ],
                "replace": {},
                "exceptions": {
                    "full shade": "shade",
                    "drought tolerant": "drought",
                    "part sun": "part-shade",
                },
            },
            "post_load": self.plant_post_load,
        }

        self.veggies = {
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
            "post_load": self.veggie_post_load,
        }

        self.houseplants = {
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
            "post_load": self.houseplant_post_load,
        }

    @staticmethod
    def plant_post_load(plant):
        output = []

        for tag in plant["tags"]:
            if tag == "reg water":
                continue
            plant["categories"].append(tag.replace(" ", "-"))

        plant["option_name_1"] = "Pot"

        if "tree" in plant["tags"] or "shrub" in plant["tags"]:
            plant["product_page"] = "trees-and-shrubs"

            plant["option_value_1"] = "gal"
            plant["price"] = 8.99

            output.append(copy.deepcopy(plant))
        else:
            plant["product_page"] = "perennials"

            plant["option_value_1"] = "4\""
            plant["price"] = 4.99

            output.append(copy.deepcopy(plant))

            plant["option_value_1"] = "qt or 5\""
            plant["price"] = 6.99

            output.append(copy.deepcopy(plant))

            plant["option_value_1"] = "gal"
            plant["price"] = 8.99

            output.append(copy.deepcopy(plant))

        return output

    @staticmethod
    def veggie_post_load(veggie):
        output = []

        match_string = json.dumps(veggie).lower()
        match_pepper = re.search(r"pepper", match_string)
        match_tomato = re.search(r"tomato", match_string)

        if match_pepper and match_tomato:
            raise Exception("What's a tomato pepper?")
        elif match_pepper:
            veggie["categories"].append("peppers")
        elif match_tomato:
            veggie["categories"].append("tomatoes")

        if "veggie" in veggie["tags"] and "herb" in veggie["tags"]:
            raise Exception("What's an herb veggie?")
        elif "veggie" in veggie["tags"]:
            veggie["product_page"] = "veggies"
        elif"herb" in veggie["tags"]:
            veggie["product_page"] = "herbs"
        else:
            raise Exception("This veggie isn't a veggie or herb.")

        veggie["option_name_1"] = "Pot"

        veggie["option_value_1"] = "3.5\""
        veggie["price"] = 2.99

        output.append(copy.deepcopy(veggie))

        veggie["option_value_1"] = "4\""
        veggie["price"] = 3.99

        output.append(copy.deepcopy(veggie))

        return output

    @staticmethod
    def houseplant_post_load(houseplant):
        output = []

        for tag in houseplant["tags"]:
            if tag == "reg water":
                continue
            elif tag == "drought":
                continue
            elif tag == "houseplant":
                continue
            houseplant["categories"].append(tag.replace(" ", "-"))

        houseplant["product_page"] = "houseplants"


        output.append(copy.deepcopy(houseplant))

        return output
