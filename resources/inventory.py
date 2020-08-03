import re
import os
import copy
import pickle
import marshmallow

from sheets import SheetsClient, SheetsInventoryMeta, SheetsInventorySchema
from squarespace import SquareSpaceInventorySchema


class Inventory:
    def __init__(self):
        print("Getting data... ", end="")
        self.get_data()
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
        self.plants = self.transform(
            self.plants,
            title="{scientific_name} ({common_name})"
        )
        print("Success!")

        print("Transforming Veggies... ", end="")
        self.plants = self.transform(
            self.veggies,
            title="{common_name}"
        )
        print("Success!")

        print("Transforming Houseplants... ", end="")
        self.plants = self.transform(
            self.houseplants,
            title="{common_name} ({scientific_name})"
        )
        print("Success!")

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

        self.plants_raw = client.get_range(
            os.environ["PLANT_SALE_INVENTORY_SPREADSHEET_ID"],
            "!".join([SheetsInventoryMeta.plants_sheet, SheetsInventoryMeta.spreadsheet_range])
        )

        self.veggies_raw = client.get_range(
            os.environ["PLANT_SALE_INVENTORY_SPREADSHEET_ID"],
            "!".join([SheetsInventoryMeta.veggies_sheet, SheetsInventoryMeta.spreadsheet_range])
        )

        self.houseplants_raw = client.get_range(
            os.environ["PLANT_SALE_INVENTORY_SPREADSHEET_ID"],
            "!".join([SheetsInventoryMeta.houseplants_sheet, SheetsInventoryMeta.spreadsheet_range])
        )

        with open("raw_data.pickle", "wb+") as f:
            pickle.dump({
                "plants": self.plants_raw,
                "veggies": self.veggies_raw,
                "houseplants": self.houseplants_raw,
            }, f)

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

    def transform(
        self,
        data,
        title,
    ):
        transformed_data = []
        schema = SquareSpaceInventorySchema()

        for item in data:
            transformed_data.append(schema.load({
                # "product_id": None,
                # "variant_id": None,
                # "product_type": None,
                # "product_page": None,
                # "product_url": None,
                "title": title.format(**item) or item["common_name"],
                # "description": None,
                # "sku": None,
                # "option_name_1": None,
                # "option_value_1": None,
                # "option_name_2": None,
                # "option_value_2": None,
                # "option_name_3": None,
                # "option_value_3": None,
                # "price": None,
                # "sale_price": None,
                # "on_sale": None,
                # "stock": None,
                # "categories": None,
                # "tags": None,
                # "weight": None,
                # "length": None,
                # "width": None,
                # "height": None,
                # "visible": None,
                # "image_url": None,
            }))

        return transformed_data

def main():
    inventory = Inventory()

if __name__ == "__main__":
    main()
