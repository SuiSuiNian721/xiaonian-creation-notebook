"""Exercise the bundled low-memory loader with real, tiny CLIP models (no download)."""
import ast
from pathlib import Path
import unittest

import torch
from accelerate import init_empty_weights
from accelerate.utils.modeling import set_module_tensor_to_device
from transformers import CLIPTextConfig, CLIPTextModel, CLIPTextModelWithProjection

SOURCE = Path(__file__).resolve().parents[1] / 'integrations/next-trainer/source/vendor/sd-scripts/library/sdxl_model_util.py'
tree = ast.parse(SOURCE.read_text(encoding='utf-8'))
loader = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == '_load_state_dict_on_device')
scope = {'set_module_tensor_to_device': set_module_tensor_to_device, 'List': list}
exec(compile(ast.Module(body=[loader], type_ignores=[]), str(SOURCE), 'exec'), scope)
load = scope['_load_state_dict_on_device']


class ClipLoadingTests(unittest.TestCase):
    def config(self):
        return CLIPTextConfig(vocab_size=32, hidden_size=8, intermediate_size=16, num_hidden_layers=2, num_attention_heads=2, max_position_embeddings=8, projection_dim=8, bos_token_id=1, eos_token_id=2, pad_token_id=0)

    def test_legacy_checkpoint_loads_into_current_clip_without_dropping_weights(self):
        source = CLIPTextModel(self.config()).eval()
        native = source.state_dict()
        legacy = {key if key.startswith('text_model.') else 'text_model.' + key: value.clone() for key, value in native.items()}
        with init_empty_weights():
            target = CLIPTextModel(self.config())
        load(target, legacy, 'cpu')
        for key, value in native.items():
            torch.testing.assert_close(target.state_dict()[key], value)
        target.eval()
        tokens = torch.tensor([[1, 3, 2]])
        with torch.no_grad():
            torch.testing.assert_close(target(tokens).last_hidden_state, source(tokens).last_hidden_state)

    def test_projection_encoder_keeps_its_existing_prefix_and_projection(self):
        source = CLIPTextModelWithProjection(self.config())
        expected = {key: value.clone() for key, value in source.state_dict().items()}
        with init_empty_weights():
            target = CLIPTextModelWithProjection(self.config())
        load(target, dict(expected), 'cpu')
        for key, value in expected.items():
            torch.testing.assert_close(target.state_dict()[key], value)

    def test_legacy_nested_model_layout_keeps_its_prefix(self):
        target = torch.nn.Module()
        target.add_module('text_model', torch.nn.Linear(3, 2))
        weights = {key: torch.randn_like(value) for key, value in target.state_dict().items()}
        load(target, dict(weights), 'cpu')
        for key, value in weights.items():
            torch.testing.assert_close(target.state_dict()[key], value)

    def test_missing_or_unexpected_weights_still_fail_strictly(self):
        target = CLIPTextModel(self.config())
        weights = dict(target.state_dict())
        weights.pop(next(iter(weights)))
        with self.assertRaisesRegex(RuntimeError, 'Missing key'):
            load(target, weights, 'cpu')
        weights = dict(target.state_dict())
        weights['not_a_model_weight'] = torch.zeros(1)
        with self.assertRaisesRegex(RuntimeError, 'Unexpected key'):
            load(target, weights, 'cpu')


if __name__ == '__main__':
    unittest.main()
