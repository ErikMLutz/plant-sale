class ColumnEnum:
    def __init__(self, column):
        self.column = column
        self.index = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".find(column)

class SheetsInventorySchema:
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
    plants_sheet = "Plants"
    veggies_sheet = "Veggies"
    houseplants_sheet = "Houseplants"

    # index of location column + 1
    number_of_columns = ColumnEnum("N").index + 1
