import marshmallow


class ColumnEnum:
    def __init__(self, column):
        self.column = column
        self.index = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".find(column)

class SheetsInventoryMeta:
    sku = ColumnEnum("A")
    scientific_name = ColumnEnum("B")
    common_name = ColumnEnum("C")
    image_url = ColumnEnum("D")
    category = ColumnEnum("E")
    tags = ColumnEnum("F")
    zone = ColumnEnum("G")
    info = ColumnEnum("H")
    pot = ColumnEnum("I")
    price = ColumnEnum("J")
    location = ColumnEnum("N")

    spreadsheet_range = "A2:N"
    plants_sheet = ["Perennials", "Trees and Shrubs"]
    veggies_sheet = ["Veggies", "Herbs"]
    houseplants_sheet = ["Houseplants"]

    # index of location column + 1
    number_of_columns = ColumnEnum("N").index + 1


class SheetsInventorySchema(marshmallow.Schema):
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
