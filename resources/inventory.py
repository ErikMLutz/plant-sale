import re
import os
import copy
import marshmallow

from sheets import SheetsClient, SheetsInventoryMeta, SheetsInventorySchema


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

    def get_data(self):
        """
        Pulls raw Plants, Veggies, and Houseplants data
        """
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


def main():
    inventory = Inventory()

if __name__ == "__main__":
    main()
