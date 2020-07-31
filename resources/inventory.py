import re
import os
import copy
import marshmallow

from sheets import SheetsClient, SheetsInventorySchema


class InventorySchema(marshmallow.Schema):
    sku = marshmallow.fields.Integer(required=True, allow_none=True)
    scientific_name = marshmallow.fields.String(required=True, allow_none=True)
    common_name = marshmallow.fields.String(required=True, allow_none=True)
    image_url = marshmallow.fields.URL(required=True, allow_none=True)
    category = marshmallow.fields.String(required=True, allow_none=True)
    tags = marshmallow.fields.String(required=True, allow_none=True)
    zone = marshmallow.fields.String(required=True, allow_none=True)
    info = marshmallow.fields.String(required=True, allow_none=True)
    pot = marshmallow.fields.String(required=True, allow_none=True)
    price = marshmallow.fields.Float(required=True, allow_none=True)
    location = marshmallow.fields.String(required=True, allow_none=True)


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
            "!".join([SheetsInventorySchema.plants_sheet, SheetsInventorySchema.spreadsheet_range])
        )

        self.veggies_raw = client.get_range(
            os.environ["PLANT_SALE_INVENTORY_SPREADSHEET_ID"],
            "!".join([SheetsInventorySchema.veggies_sheet, SheetsInventorySchema.spreadsheet_range])
        )

        self.houseplants_raw = client.get_range(
            os.environ["PLANT_SALE_INVENTORY_SPREADSHEET_ID"],
            "!".join([SheetsInventorySchema.houseplants_sheet, SheetsInventorySchema.spreadsheet_range])
        )

    def clean(self, data):
        data = copy.deepcopy(data)
        schema = InventorySchema()
        cleaned_data = []

        for i, row in enumerate(data):
            try:
                # convert '' to None and pad missing values at end
                row = [
                    item if item != "" else None
                    for item in row + [""] * (SheetsInventorySchema.number_of_columns - len(row))
                ]

                # skip rows without SKUs
                if row[SheetsInventorySchema.sku.index] is None: 
                    continue

                cleaned_data.append(schema.load({
                    "sku": row[SheetsInventorySchema.sku.index],
                    "scientific_name": row[SheetsInventorySchema.scientific_name.index],
                    "common_name": row[SheetsInventorySchema.common_name.index],
                    "image_url": row[SheetsInventorySchema.image_url.index],
                    "category": row[SheetsInventorySchema.category.index],
                    "tags": row[SheetsInventorySchema.tags.index],
                    "zone": row[SheetsInventorySchema.zone.index],
                    "info": row[SheetsInventorySchema.info.index],
                    "pot": str(row[SheetsInventorySchema.pot.index]),
                    "price": row[SheetsInventorySchema.price.index],
                    "location": str(row[SheetsInventorySchema.location.index]),
                }))
            except Exception as e:
                print(i, row)
                raise e

        return cleaned_data


def main():
    inventory = Inventory()

if __name__ == "__main__":
    main()
