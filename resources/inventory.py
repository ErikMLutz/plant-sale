import re
import os
import csv
import copy
import pprint
import pickle
import marshmallow

from fuzzywuzzy import fuzz, process

from drive import DriveClient
from sheets import SheetsClient, SheetsInventoryMeta, SheetsInventorySchema
from squarespace import SquareSpaceInventorySchema, INVENTORY_HEADER
from resources.configuration import Configuration

CONFIGURATION = Configuration()
FUZZY_MATCH_THRESHOLD = CONFIGURATION.fuzzy_match_threshold


class Inventory:
    def __init__(self):
        self.categories = {
            "perennials": set(),
            "trees-and-shrubs": set(),
            "veggies": set(),
            "houseplants": set(),
            "herbs": set(),
        }

        self.title_map = {}

        print("Getting data... ", end="")
        self.get_data()
        print("Success!")

        print("Getting image metadata... ", end="")
        self.get_image_metadata()
        print("Success!")

        print("Cleaning Image Metadata... ", end="")
        self.image_metadata = self.clean_image_metadata(self.image_metadata_raw)
        print("Success!")

        print("Cleaning Plants... ", end="")
        self.plants = self.clean(self.plants_raw)
        print("Success!")

        print("Cleaning Veggies... ", end="")
        self.veggies = self.clean(self.veggies_raw)
        print("Success!")

        print("Cleaning Houseplants... ", end="")
        self.houseplants = self.clean(self.houseplants_raw)
        print("Success!")

        print("Transforming Plants... ", end="")
        self.plants = self.transform(self.plants, CONFIGURATION.plants)
        print("Success!")

        print("Transforming Veggies... ", end="")
        self.veggies = self.transform(self.veggies, CONFIGURATION.veggies)
        print("Success!")

        print("Transforming Houseplants... ", end="")
        self.houseplants = self.transform(self.houseplants, CONFIGURATION.houseplants)
        print("Success!")

        print("Writing Plants... ", end="")
        self.plants = self.write("data/plants.csv", self.plants)
        print("Success!")

        print("Writing Veggies... ", end="")
        self.plants = self.write("data/veggies.csv", self.veggies)
        print("Success!")

        print("Writing Houseplants... ", end="")
        self.plants = self.write("data/houseplants.csv", self.houseplants)
        print("Success!")

        print("Writing Title Map... ", end="")
        with open("title_map.csv", "w+") as f:
            f.write("SKU\tMatch String\tPot\tTitle\n")
            for (sku, scientific_name, common_name, pot), title in self.title_map.items():
                f.write(f"{str(sku)}\t{scientific_name} ({common_name})\t{pot}\t{title}".replace("\n", " ") + "\n")
        print("Success!")

        print("\nCategories:")
        pprint.pprint(self.categories)

    def get_data(self):
        """
        Pulls raw Plants, Veggies, and Houseplants data
        """

        # pull data from pickled store if available
        if os.path.exists("raw_data.pickle"):
            print("from pickled store... ", end="")
            with open("raw_data.pickle", "rb") as f:
                data = pickle.load(f)

                self.plants_raw = data["plants"]
                self.veggies_raw = data["veggies"]
                self.houseplants_raw = data["houseplants"]

            return

        print("from online spreadsheet... ", end="")
        client = SheetsClient()

        self.plants_raw = []
        for sheet in SheetsInventoryMeta.plants_sheet:
            self.plants_raw += client.get_range(
                os.environ["PLANT_SALE_INVENTORY_SPREADSHEET_ID"],
                "!".join([f"'{sheet}'", SheetsInventoryMeta.spreadsheet_range])
            )

        self.veggies_raw = []
        for sheet in SheetsInventoryMeta.veggies_sheet:
            self.veggies_raw += client.get_range(
                os.environ["PLANT_SALE_INVENTORY_SPREADSHEET_ID"],
                "!".join([f"'{sheet}'", SheetsInventoryMeta.spreadsheet_range])
            )

        self.houseplants_raw = []
        for sheet in SheetsInventoryMeta.houseplants_sheet:
            self.houseplants_raw += client.get_range(
                os.environ["PLANT_SALE_INVENTORY_SPREADSHEET_ID"],
                "!".join([f"'{sheet}'", SheetsInventoryMeta.spreadsheet_range])
            )

        with open("raw_data.pickle", "wb+") as f:
            pickle.dump({
                "plants": self.plants_raw,
                "veggies": self.veggies_raw,
                "houseplants": self.houseplants_raw,
            }, f)

    def get_image_metadata(self):
        """
        Pulls image metadata from Drive folder
        """

        # pull data from pickled store if available
        if os.path.exists("raw_image_metadata.pickle"):
            print("from pickled store... ", end="")
            with open("raw_image_metadata.pickle", "rb") as f:
                data = pickle.load(f)
                self.image_metadata_raw = data["image_metadata"]

            return

        print("from online folder... ", end="")
        client = DriveClient()

        self.image_metadata_raw = []
        for folder_id in CONFIGURATION.image_search_folders.values():
            self.image_metadata_raw += client.list_files_in_folder(folder_id=folder_id)   

        with open("raw_image_metadata.pickle", "wb+") as f:
            pickle.dump({"image_metadata": self.image_metadata_raw}, f)

    def clean_image_metadata(self, data):
        data = copy.deepcopy(data)
        cleaned_data = []

        for image in data:
            name = image["name"].lower()
            name = re.sub(r"[\d\(\)\._]", " ", name)
            name = re.sub(r"\s+", " ", name)
            name = re.sub(r"jpg", " ", name)

            cleaned_data.append({
                "name": image["name"],
                "cleaned_name": name,
                "id": image["id"],
                "download": image["download"],
            })

        return cleaned_data

    def match_image_metadata(self, item):
        query = f"{item['scientific_name']} {item['common_name']}".lower()
        choices = {image["download"]: image["cleaned_name"] for image in self.image_metadata}

        matches = []
        for scorer in [
            fuzz.token_set_ratio,
            fuzz.token_sort_ratio,
        ]:
            matches += process.extractBests(query, choices, scorer=scorer, limit=5)

        # deduplicate matches from different scorers
        best_matches = {}
        for match in matches:
            best_matches[match[2]] = [
                match[0],
                max(match[1], best_matches.get(match[-1], [0, 0, 0])[1]),
                match[2]
            ]
        matches = list(best_matches.values())

        matches = filter(lambda match: match[1] >= CONFIGURATION.fuzzy_match_image_metadata_threshold, matches)
        matches = sorted(matches, key=lambda item: item[1])
        matches = [match[2] for match in matches]

        if not matches:
            return None

        return matches

    def clean(self, data):
        data = copy.deepcopy(data)
        schema = SheetsInventorySchema()
        cleaned_data = []

        for i, row in enumerate(data):
            try:
                # convert '' to None and pad missing values at end
                row = [
                    item if item != "" else None
                    for item in row + [""] * (SheetsInventoryMeta.number_of_columns - len(row))
                ]

                # skip rows without SKUs
                if row[SheetsInventoryMeta.sku.index] is None: 
                    continue

                cleaned_data.append(schema.load({
                    "sku": row[SheetsInventoryMeta.sku.index],
                    "scientific_name": row[SheetsInventoryMeta.scientific_name.index],
                    "common_name": row[SheetsInventoryMeta.common_name.index],
                    "image_url": row[SheetsInventoryMeta.image_url.index],
                    "category": row[SheetsInventoryMeta.category.index],
                    "tags": row[SheetsInventoryMeta.tags.index],
                    "zone": row[SheetsInventoryMeta.zone.index],
                    "info": row[SheetsInventoryMeta.info.index],
                    "pot": str(row[SheetsInventoryMeta.pot.index]),
                    "price": row[SheetsInventoryMeta.price.index],
                    "location": str(row[SheetsInventoryMeta.location.index]),
                }))
            except Exception as e:
                print(i, row)
                raise e

        return cleaned_data

    def transform(self, data, transform_configuration):
        transformed_data = []
        schema = SquareSpaceInventorySchema()

        sorted_data = sorted(
            copy.deepcopy(data),
            key=lambda item: transform_configuration["title"].format(**item),
            reverse=True,
        )

        for item in sorted_data:
            try:
                title = transform_configuration["title"].format(**item)
                self.title_map[(item["sku"], item["scientific_name"], item["common_name"], item["pot"])] = title

                description = f"<p>{item['info']}, {item['zone']}</p>"
                tags = self.transform_tags(
                    item["category"] + "," + item["tags"],
                    transform_configuration["tags"]
                )
                image_url = self.match_image_metadata(item)

                transformed_item = schema.load(dict(
                    title=title, description=description, tags=tags, image_url=image_url,
                ))

                post_load_data = transform_configuration["post_load"](copy.deepcopy(transformed_item))
                for i in range(1, len(post_load_data)):
                    for column in [
                        "product_type",
                        "product_page",
                        "product_url",
                        "title",
                        "description",
                        "categories",
                        "tags",
                        "visible",
                        "image_url",
                    ]:
                        post_load_data[i][column] = None

                self.categories[post_load_data[0]["product_page"]] |= set(post_load_data[0]["categories"])

                transformed_data += post_load_data
            except Exception as e:
                pprint.pprint(item)
                raise e

        return transformed_data

    def transform_tags(self, candidate_tags, tag_configuration):
        transformed_tags = set()

        candidate_tags = re.split(r"\s*[,/]+\s*", candidate_tags)

        for tag in candidate_tags:
            if tag == "":
                continue

            match = process.extractOne(tag, tag_configuration["valid"])
            exclude_match = process.extractOne(tag, tag_configuration["exclude"])
            if match is not None and match[1] >= FUZZY_MATCH_THRESHOLD:
                transformed_tags.add(tag_configuration["replace"].get(match[0], match[0]))
            elif exclude_match is not None and exclude_match[1] >= FUZZY_MATCH_THRESHOLD:
                continue
            elif tag_configuration["exceptions"].get(tag):
                transformed_tags.add(tag_configuration["exceptions"].get(tag))
            else:
                raise Exception(f"No tag match found for '{tag}'.")

        return list(transformed_tags)

    def write(self, file_name, data):
        schema = SquareSpaceInventorySchema(many=True)

        serialized_data = schema.dump(copy.deepcopy(data))
        with open(file_name, 'w+', newline='') as f:
            fieldnames = list(SquareSpaceInventorySchema._declared_fields.keys())
            writer = csv.DictWriter(f, fieldnames=fieldnames)

            writer.writerow(INVENTORY_HEADER)
            for item in serialized_data:
                writer.writerow(item)


def main():
    inventory = Inventory()

if __name__ == "__main__":
    main()
