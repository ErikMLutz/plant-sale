import marshmallow

INVENTORY_HEADER = {
    "product_id": "Product ID [Non Editable]",
    "variant_id": "Variant ID [Non Editable]",
    "product_type": "Product Type [Non Editable]",
    "product_page": "Product Page",
    "product_url": "Product URL",
    "title": "Title",
    "description": "Description",
    "sku": "SKU",
    "option_name_1": "Option Name 1",
    "option_value_1": "Option Value 1",
    "option_name_2": "Option Name 2",
    "option_value_2": "Option Value 2",
    "option_name_3": "Option Name 3",
    "option_value_3": "Option Value 3",
    "price": "Price",
    "sale_price": "Sale Price",
    "on_sale": "On Sale",
    "stock": "Stock",
    "categories": "Categories",
    "tags": "Tags",
    "weight": "Weight",
    "length": "Length",
    "width": "Width",
    "height": "Height",
    "visible": "Visible",
    "image_url": "Hosted Image URLs",
}


class SquareSpaceInventorySchema(marshmallow.Schema):
    product_id = marshmallow.fields.String(missing=None)
    variant_id = marshmallow.fields.String(missing=None)
    product_type = marshmallow.fields.String(missing="SERVICE")
    product_page = marshmallow.fields.String(missing=None)
    product_url = marshmallow.fields.String(missing=None)
    title = marshmallow.fields.String(missing=None)
    description = marshmallow.fields.String(missing=None)
    sku = marshmallow.fields.String(missing=None)
    option_name_1 = marshmallow.fields.String(missing=None)
    option_value_1 = marshmallow.fields.String(missing=None)
    option_name_2 = marshmallow.fields.String(missing=None)
    option_value_2 = marshmallow.fields.String(missing=None)
    option_name_3 = marshmallow.fields.String(missing=None)
    option_value_3 = marshmallow.fields.String(missing=None)
    price = marshmallow.fields.Float(missing=None)
    sale_price = marshmallow.fields.Float(missing=None)
    on_sale = marshmallow.fields.String(missing="No", validate=marshmallow.validate.OneOf(["No", "Yes"]))
    stock = marshmallow.fields.Integer(missing=0)
    categories = marshmallow.fields.List(marshmallow.fields.String, missing=[])
    tags = marshmallow.fields.List(marshmallow.fields.String, missing=[])
    weight = marshmallow.fields.Float(missing=1.0)
    length = marshmallow.fields.Float(missing=0.0)
    width = marshmallow.fields.Float(missing=0.0)
    height = marshmallow.fields.Float(missing=0.0)
    visible = marshmallow.fields.String(missing="Yes", validate=marshmallow.validate.OneOf(["No", "Yes"]))
    image_url = marshmallow.fields.List(marshmallow.fields.URL(), missing=None)

    @marshmallow.post_dump
    def join_lists(self, data, many, **kwargs):
        for list_field in ["categories", "tags"]:
            data[list_field] = ", ".join(data[list_field] or [])

        data["image_url"] = " ".join(data["image_url"] or [])

        return data
